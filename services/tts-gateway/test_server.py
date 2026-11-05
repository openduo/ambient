#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Tests of the gateway's text path: `python3 -m unittest test_server` in this directory.

server.py imports numpy, soxr, websockets and libopus when it loads. The tests drive Upstream,
Audio8Upstream and Task.text against a fake upstream socket and touch none of them, so all four
are stubbed during the import and the tests run without the gateway's venv.
"""
import importlib.util
import json
import os
import re
import sys
import types
import unittest
from unittest import mock


def load_server():
    """Imports server.py with its audio and network libraries replaced by stubs."""

    class Samples:
        def __init__(self, data):
            self.data = data

        def tobytes(self):
            return self.data

    class ResampleStream:
        """Hands PCM through: the fake upstream speaks at the task's rate."""

        def __init__(self, in_rate, out_rate, channels, dtype=None):
            assert in_rate == out_rate

        def resample_chunk(self, samples, last=False):
            return samples

    def module(name, **attrs):
        mod = types.ModuleType(name)
        vars(mod).update(attrs)
        return mod

    stubs = {
        "numpy": module("numpy", int16="int16", frombuffer=lambda data, dtype=None: Samples(data)),
        "soxr": module("soxr", ResampleStream=ResampleStream),
        "websockets": module("websockets"),
        "websockets.asyncio": module("websockets.asyncio"),
        "websockets.asyncio.client": module("websockets.asyncio.client", connect=None),
        "websockets.asyncio.server": module("websockets.asyncio.server", serve=None),
        "websockets.exceptions": module("websockets.exceptions", ConnectionClosed=Exception),
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
    spec = importlib.util.spec_from_file_location("tts_gateway_server", path)
    server = importlib.util.module_from_spec(spec)
    saved = {name: sys.modules[name] for name in stubs if name in sys.modules}
    sys.modules.update(stubs)
    try:
        # libopus is loaded at import: a mock stands in for the library.
        with mock.patch("ctypes.util.find_library", return_value="opus"), \
                mock.patch("ctypes.CDLL"):
            spec.loader.exec_module(server)
    finally:
        for name in stubs:
            sys.modules.pop(name, None)
        sys.modules.update(saved)
    return server


server = load_server()

RATE = 16000
# What drama-3 starts a new sentence after, for the fixtures here (none has an ASCII ".").
FAKE_SENTENCE_END = re.compile(r"(?<=[!?。！？])(?![!?。！？])")


class FakeUpstreamSocket:
    """Stands in for the drama-3 stream socket.

    It records the client's messages. Once `input.done` is in, it answers as the real server
    does: each sentence of the text it received (stripped of surrounding whitespace) is an
    `audio.start` with that text, binary PCM and an `audio.done`; then `session.done`. A sentence
    i has 100 * (i + 1) samples, so every sentence ends at a different sample.
    """

    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def recv(self):
        return json.dumps({"type": "session.configured"})

    async def close(self):
        pass

    def received_text(self):
        return "".join(m["text"] for m in self.sent if m["type"] == "input.text")

    def __aiter__(self):
        return self._events()

    async def _events(self):
        assert self.sent and self.sent[-1]["type"] == "input.done"
        sentences = [s.strip() for s in FAKE_SENTENCE_END.split(self.received_text())]
        for i, sentence in enumerate([s for s in sentences if s]):
            yield json.dumps({"type": "audio.start", "sentence_text": sentence,
                              "sample_rate": RATE})
            yield b"\0\0" * 100 * (i + 1)
            yield json.dumps({"type": "audio.done"})
        yield json.dumps({"type": "session.done"})


def chunked(text, size):
    """`text` in pieces of `size` characters, as the cerebellum streams it; one piece if None."""
    size = size or len(text)
    return [text[i:i + size] for i in range(0, len(text), size)]


class UpstreamTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        async def connect(url, **kwargs):
            return self.ws

        patch = mock.patch.object(server, "connect", connect)
        patch.start()
        self.addCleanup(patch.stop)

    async def open(self):
        """A task whose drama-3 upstream is opened on a fresh fake socket."""
        self.ws = FakeUpstreamSocket()
        self.task = server.Task(None, "task-1", None, {"sample_rate": RATE})
        self.task.upstream = server.Upstream(self.task)
        await self.task.upstream.open()
        return self.task

    async def speak(self, pieces):
        """Sends `pieces` as continue-task texts and ends the task; returns the texts that
        reached the upstream, in order."""
        task = await self.open()
        for piece in pieces:
            await task.text(piece)
        await task.upstream.end()
        assert self.ws.sent[-1] == {"type": "input.done"}
        return [m["text"] for m in self.ws.sent if m["type"] == "input.text"]

    async def marks(self, pieces):
        """The sentence marks the task's text gets: (end_sample, text_end) per sentence."""
        await self.speak(pieces)
        return [item async for item in self.task.upstream.pcm() if isinstance(item, tuple)]


class ColonRewriteTest(UpstreamTestCase):
    async def test_full_width_label_becomes_a_full_width_comma(self):
        self.assertEqual(await self.speak(["标题：内容。"]), ["标题，内容。"])

    async def test_ascii_label_becomes_an_ascii_comma(self):
        self.assertEqual(await self.speak(["Note: the door is closed!"]),
                         ["Note, the door is closed!"])

    async def test_colon_between_digits_stays(self):
        for text in ("会议在10:30开始。", "比分是1:1！", "10:30:15 开始。", "3：2 获胜！"):
            with self.subTest(text=text):
                self.assertEqual(await self.speak([text]), [text])

    async def test_full_width_digits_count_as_digits(self):
        for text in ("会议在１０：３０开始。", "会议在１０:３０开始。", "会议在10：３０开始。"):
            with self.subTest(text=text):
                self.assertEqual(await self.speak([text]), [text])

    async def test_digit_on_one_side_only_is_rewritten(self):
        for text, want in (("第1：内容。", "第1，内容。"),
                           ("内容：2号。", "内容，2号。"),
                           ("A1: go!", "A1, go!"),
                           ("a: 1!", "a, 1!"),
                           ("1::2。", "1,,2。")):
            with self.subTest(text=text):
                self.assertEqual(await self.speak([text]), [want])

    async def test_colon_in_a_direction_is_rewritten(self):
        # Accepted on purpose: a direction's colon means the same as a comma, and one rule
        # without a markup exception is simpler.
        self.assertEqual(await self.speak(["[轻声：慢慢说]好的。"]), ["[轻声，慢慢说]好的。"])

    async def test_a_colon_ending_a_text_is_decided_by_the_next_text(self):
        for pieces, want in ((["会议在10:", "30开始。"], "会议在10:30开始。"),
                             (["会议在10", ":", "30开始。"], "会议在10:30开始。"),
                             (["会议在１０：", "３０开始。"], "会议在１０：３０开始。"),
                             (["提示:", "请稍等。"], "提示,请稍等。"),
                             (["第1:", "内容。"], "第1,内容。"),
                             (["内容", "：", "2号。"], "内容，2号。"),
                             (["a:", ":", "b!"], "a,,b!")):
            with self.subTest(pieces=pieces):
                self.assertEqual(await self.speak(pieces), [want])

    async def test_text_after_the_last_sentence_end_goes_out_with_the_end(self):
        task = await self.open()
        await task.text("会议在10:")
        await task.text("30开始。再")
        await task.text("见：")
        self.assertEqual([m["text"] for m in self.ws.sent if m["type"] == "input.text"],
                         ["会议在10:30开始。"])
        await task.upstream.end()
        self.assertEqual([m["text"] for m in self.ws.sent if m["type"] == "input.text"],
                         ["会议在10:30开始。", "再见，"])

    async def test_a_colon_starting_a_piece_has_the_sentence_end_before_it(self):
        # The piece before it was sent already, and ended at a sentence end or whitespace.
        for pieces, want in ((["好的。", ":3好。"], ["好的。", ",3好。"]),
                             (["好的！", "：3好。"], ["好的！", "，3好。"]),
                             (["好的。\n", ":3好。"], ["好的。\n", ",3好。"]),
                             (["好的。", ":", "3好。"], ["好的。", ",3好。"]),
                             (["好的。", "：好。"], ["好的。", "，好。"])):
            with self.subTest(pieces=pieces):
                self.assertEqual(await self.speak(pieces), want)

    async def test_final_colon_is_rewritten_at_the_end(self):
        for pieces, want in ((["请稍等："], ["请稍等，"]),
                             (["Wait:"], ["Wait,"]),
                             (["好的。", "稍等："], ["好的。", "稍等，"]),
                             (["时间是10:"], ["时间是10,"]),
                             (["10", ":"], ["10,"])):
            with self.subTest(pieces=pieces):
                self.assertEqual(await self.speak(pieces), want)

    async def test_the_same_text_comes_out_however_it_is_cut(self):
        # (text, what the upstream must receive). The fixtures all have words after their
        # last sentence end, so nothing is dropped at the end.
        cases = (
            ("标题：内容。", "标题，内容。"),
            ("会议在10:30开始！", "会议在10:30开始！"),
            ("第1：内容。2:3 比分：5:2！", "第1，内容。2:3 比分，5:2！"),
            ("Note: 3:2 [soft: yes]!", "Note, 3:2 [soft, yes]!"),
            ("好：：好", "好，，好"),
            (":10", ",10"),
            ("请稍等：", "请稍等，"),
            ("好的。稍等：", "好的。稍等，"),
        )
        for text, want in cases:
            for size in (1, 2, 3, 5, None):
                with self.subTest(text=text, size=size):
                    sent = await self.speak(chunked(text, size))
                    self.assertEqual("".join(sent), want)
                    self.assertEqual(self.task.upstream.text_in, want)

    async def test_emoji_before_a_colon_is_its_left_neighbour(self):
        # The pair is split over two texts; the colon after it has a non-digit on its left.
        self.assertEqual(await self.speak(["\ud83d", "\ude00：好。"]), ["😀，好。"])


class MarkTest(UpstreamTestCase):
    async def test_marks_and_text_end_are_the_same_with_and_without_colons(self):
        with_colons = "标题：内容。第二句：更多！会议在10:30。Note: ok!"
        with_commas = "标题，内容。第二句，更多！会议在10:30。Note, ok!"
        # Every sentence finds its place in the text; the last mark ends where all the text does.
        want = [(100, 6), (300, 13), (600, 22), (1000, len(with_colons))]
        self.assertEqual(len(with_colons), len(with_commas))
        for size in (1, 2, 3, None):
            with self.subTest(size=size):
                self.assertEqual(await self.marks(chunked(with_colons, size)), want)
                self.assertEqual(self.ws.received_text(), with_commas)
                self.assertEqual(await self.marks(chunked(with_commas, size)), want)

    async def test_a_colon_free_text_has_the_marks_it_had(self):
        text = "你好，世界。再见！还有一句"
        self.assertEqual(await self.marks(chunked(text, 2)),
                         [(100, 6), (300, 9), (600, len(text))])

    async def test_text_end_counts_a_final_colon(self):
        self.assertEqual(await self.marks(["好的。", "稍等："]), [(100, 3), (300, 6)])

    async def test_the_last_mark_covers_a_word_free_tail_that_is_not_sent(self):
        self.assertEqual(await self.speak(["好的。", "」"]), ["好的。"])
        self.assertEqual(await self.marks(["好的。", "」"]), [(100, 4)])
        self.assertEqual(await self.marks(["好：", "的。", "」"]), [(100, 5)])


class UnchangedBehaviourTest(UpstreamTestCase):
    async def test_colon_free_text_is_sent_as_it_was(self):
        self.assertEqual(await self.speak(["你好，", "世界。再", "见！还", "有", "一句"]),
                         ["你好，世界。", "再见！", "还有一句"])
        self.assertEqual(await self.speak(["[笑]好的。", "[笑]"]), ["[笑]好的。", "[笑]"])
        self.assertEqual(await self.speak(["a,b.c ", "d。"]), ["a,b.c d。"])

    async def test_messages_are_the_session_config_the_texts_and_done(self):
        await self.speak(["好。"])
        self.assertEqual([m["type"] for m in self.ws.sent],
                         ["session.config", "input.text", "input.done"])

    async def test_a_word_free_last_piece_is_dropped(self):
        self.assertEqual(await self.speak(["你好。", "」\n"]), ["你好。"])
        self.assertEqual(await self.speak(["好的。", "</soft>"]), ["好的。"])
        self.assertEqual(await self.speak(["好的。\n", "”"]), ["好的。\n"])

    async def test_a_word_free_piece_between_sentences_is_not_dropped(self):
        self.assertEqual(await self.speak(["好的。", "」\n", "再见。"]), ["好的。", "」\n再见。"])

    async def test_a_split_surrogate_pair_is_joined_and_counted_once(self):
        sent = await self.speak(["\ud83d", "\ude00。"])
        self.assertEqual(sent, ["😀。"])
        self.assertEqual(self.task.chars, 2)

    async def test_a_lone_surrogate_becomes_one_replacement_character(self):
        sent = await self.speak(["\ude00好。"])
        self.assertEqual(sent, ["\ufffd好。"])
        self.assertEqual(self.task.chars, 3)


class Audio8UpstreamTest(unittest.IsolatedAsyncioTestCase):
    async def test_colons_are_left_alone(self):
        task = server.Task(None, "task-1", None, {"sample_rate": RATE})
        upstream = server.Audio8Upstream(task)
        for piece in ("标题：内", "容。Note:", " 10:30 ok！", "末尾："):
            await upstream.text(piece)
        await upstream.end()
        queued = []
        while (item := upstream.sentences.get_nowait()) is not None:
            queued.append(item)
        self.assertEqual(queued, [("标题：内容。", 6), ("Note: 10:30 ok！", 21), ("末尾：", 24)])


class SoftenColonsTest(unittest.TestCase):
    def test_length_never_changes(self):
        for text in ("", "：", ":", "a：b:c", "1:2", "１：２", "：：:", "[x：y]"):
            with self.subTest(text=text):
                self.assertEqual(len(server.soften_colons(text)), len(text))

    def test_digits_decide_both_colons(self):
        self.assertEqual(server.soften_colons("1:2 1：2 a:2 1:a a:a"), "1:2 1：2 a,2 1,a a,a")
        self.assertEqual(server.soften_colons("1：2 1:2 a：2 1：a a：a"), "1：2 1:2 a，2 1，a a，a")


if __name__ == "__main__":
    unittest.main()
