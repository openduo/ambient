// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The reading column: persisted room records, live speech preview, interruption facts and the
 * per-turn process disclosure.
 *
 * Two rules carried over from the page this replaces. Live preview rows are provisional — the
 * persisted imlog row replaces them, and an unmatched preview is kept rather than discarded,
 * because it may never have been persisted. And arriving content never steals the reader's scroll
 * position: collection continues while following is paused.
 */
import { foldDuoduoSaid } from "./said.js";

const TURN_LABEL = {
  received: "收到",
  thinking: "思考",
  tool: "工具",
  speaking: "在说",
  done: "完成"
};

/**
 * The four types `GET /api/attachment` serves inline; the route
 * (`server/http.ts::INLINE_ATTACHMENT_MIME`) owns the policy and this is the page's matching read
 * side. Anything else comes back as a download, so the page never tries to decode it.
 */
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function createConversation(deps) {
  const { $, document } = deps;
  const { rq, fetch: httpFetch, createImageBitmap: decodeBitmap } = deps;

  /* Display all timestamps in local time so ordering remains readable across columns. */
  function fmtAt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "??:??";
    const p = (n) => String(n).padStart(2, "0");
    const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const n = new Date();
    const same =
      d.getFullYear() === n.getFullYear() &&
      d.getMonth() === n.getMonth() &&
      d.getDate() === n.getDate();
    return same ? hhmm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm}`;
  }

  function fmtNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let following = true;
  /** Arriving content never moves the reader; it only offers a way back to the latest row. */
  function followLatest(box) {
    if (following) {
      box.scrollTop = box.scrollHeight;
      return;
    }
    if (box === $("messages")) $("new-message").hidden = false;
  }
  function atBottom() {
    const area = $("messages");
    return area.scrollHeight - Math.ceil(area.scrollTop) <= area.clientHeight;
  }
  function onScroll() {
    following = atBottom();
    if (following) $("new-message").hidden = true;
  }
  function scrollLatest() {
    following = true;
    followLatest($("messages"));
    $("new-message").hidden = true;
  }
  /**
   * A hidden column measures zero, so rows that arrived while the panel was on screen left the
   * reader at the top. Re-follow once it is visible. This respects the reader's own position: if
   * they had scrolled away, it offers the way back instead of moving them.
   */
  function refollow() {
    followLatest($("messages"));
    paintPending();
  }

  /** One reading row. Author, origin and time stay separate facts. */
  function messageRow(author, origin, time, assistant) {
    const row = document.createElement("article");
    row.className = "message" + (assistant ? " assistant" : "");
    const body = document.createElement("div");
    body.className = "message-body";
    const meta = document.createElement("div");
    meta.className = "meta";
    const who = document.createElement("span");
    who.className = "author";
    who.textContent = author;
    const from = document.createElement("span");
    from.textContent = origin;
    const at = document.createElement("time");
    at.textContent = time;
    if (author) meta.append(who);
    meta.append(from, at);
    body.append(meta);
    row.append(body);
    return { row, body };
  }

  function textBlock(lines) {
    const text = document.createElement("div");
    text.className = "message-text";
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      text.append(p);
    }
    return text;
  }

  /* Insert by event time because batched cleanup may arrive after newer replies. */
  function insertByTime(box, node) {
    let ref = null;
    for (let n = box.lastElementChild; n; n = n.previousElementSibling) {
      if ((n.dataset.at || "") <= (node.dataset.at || "")) break;
      ref = n;
    }
    box.insertBefore(node, ref);
    if (!ref) followLatest(box); // Follow only insertions at the end.
  }

  const typedRows = new Map();
  const answered = new Set();
  const recordLost = new Set();
  const renderedImlogKeys = new Set();
  let ambientFold = null;

  /** Address the channel's own copy of the bytes; the daemon's inbox is the brain's copy. */
  function attachmentUrl(attachment) {
    const base = rq("/api/attachment");
    const q = [
      `sha256=${encodeURIComponent(attachment.sha256)}`,
      `mime=${encodeURIComponent(attachment.mime || "")}`,
      `name=${encodeURIComponent(attachment.name || "")}`
    ].join("&");
    return `${base}${base.includes("?") ? "&" : "?"}${q}`;
  }

  /** A name the reader can act on: addressable rows download, older rows only say what arrived. */
  function nameChip(attachment) {
    if (!attachment.sha256) {
      const span = document.createElement("span");
      span.textContent = attachment.name || "";
      return span;
    }
    const link = document.createElement("a");
    link.href = attachmentUrl(attachment);
    link.download = attachment.name || "";
    link.textContent = attachment.name || "";
    return link;
  }

  const pendingPaint = new Set();
  /**
   * A hidden column measures zero and history rows are created while the panel is on screen, so a
   * bitmap sized from that measurement would be one pixel wide. Paint only once the row has a real
   * width, on the same reveal hook the scroll position already uses. There is no fallback width:
   * a guessed number would be wrong on every screen it was not guessed for.
   */
  function paintPending() {
    for (const task of [...pendingPaint]) {
      if (!task.handle.alive) {
        pendingPaint.delete(task);
        continue;
      }
      // Zero means the node is not measurable yet, not that the row is zero wide.
      const css = task.list.clientWidth || 0;
      if (css <= 0) continue;
      pendingPaint.delete(task);
      // Device pixels, not CSS pixels: the bitmap is what the machine holds.
      void task.run(Math.round(css * globalThis.devicePixelRatio));
    }
  }
  function queuePaint(task) {
    pendingPaint.add(task);
    paintPending();
  }

  /**
   * One picture, decoded once at display size. The full-resolution decode is never retained: a
   * phone photo costs tens of megabytes as an `<img>`, and a day of history holds dozens of rows.
   */
  function imageSlot(list, handle, source, attachment) {
    const slot = document.createElement("div");
    slot.className = "message-attachment";
    const chip = document.createElement("span");
    chip.textContent = attachment.name || "";
    slot.append(chip);
    const task = {
      handle,
      list,
      async run(width) {
        let bitmap = null;
        try {
          bitmap = await decodeBitmap(await source(), {
            resizeWidth: width,
            resizeQuality: "medium"
          });
          if (!handle.alive) return;
          const canvas = document.createElement("canvas");
          canvas.className = "message-attachment-image";
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          canvas.tabIndex = 0;
          canvas.setAttribute("role", "button");
          canvas.setAttribute("aria-label", `放大图片 ${attachment.name || ""}`);
          canvas.addEventListener("click", () => {
            const preview = $("image-preview");
            const content = $("image-preview-content");
            const full = document.createElement("canvas");
            full.width = canvas.width;
            full.height = canvas.height;
            full.className = "image-preview-canvas";
            full.getContext("2d").drawImage(canvas, 0, 0);
            content.replaceChildren(full);
            preview.showModal();
          });
          canvas.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") canvas.click();
          });
          slot.replaceChildren(canvas);
        } catch {
          // Say what arrived and let the reader ask again; a lost picture is not a lost row.
          slot.replaceChildren(chip);
          chip.onclick = () => {
            chip.onclick = null;
            queuePaint(task);
          };
        } finally {
          // The canvas holds the pixels now. Release the decode on every exit, including a
          // painting failure, or the row keeps a full bitmap it never shows.
          bitmap?.close();
        }
      }
    };
    queuePaint(task);
    return slot;
  }

  /**
   * The pictures a row carries. A local `File` beats a fetch of the same bytes: the page already
   * holds it, so the row that was just sent never waits on the network to show what was attached.
   */
  function attachmentsNode(attachments, files) {
    if (!attachments?.length) return null;
    const list = document.createElement("div");
    list.className = "message-attachments";
    const handle = { alive: true };
    for (const [index, attachment] of attachments.entries()) {
      const file = files?.[index];
      const source =
        file && INLINE_MIME.has(file.type)
          ? () => file
          : attachment.sha256 && INLINE_MIME.has(attachment.mime)
            ? async () => {
                const response = await httpFetch(attachmentUrl(attachment));
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.blob();
              }
            : null;
      list.append(source ? imageSlot(list, handle, source, attachment) : nameChip(attachment));
    }
    return { list, handle };
  }

  /**
   * The receipt and the record row complete the same row in either order, and each knows something
   * the other does not: the receipt carries the bytes the page still holds, the record row carries
   * the content key that makes the file reachable later. The entry keeps both, and rebuilds the
   * pictures whenever one of them adds what the other lacked — always from the local files when
   * there are any, so a rebuild never fetches bytes the page is already holding.
   */
  function setAttachments(entry, attachments, files) {
    if (files?.length) entry.attachmentFiles = files;
    const known = entry.attachmentsMeta;
    const gainedKey = Boolean(
      attachments?.length && attachments.some((a, i) => a.sha256 && !known?.[i]?.sha256)
    );
    if (attachments?.length && (!known || gainedKey)) entry.attachmentsMeta = attachments;
    const gainedFiles = Boolean(files?.length) && !entry.attachmentsLocal;
    if (entry.attachments && !gainedKey && !gainedFiles) return;
    const node = attachmentsNode(entry.attachmentsMeta, entry.attachmentFiles);
    if (!node) return;
    if (entry.attachments) {
      entry.attachmentsHandle.alive = false;
      entry.attachments.replaceWith(node.list);
    } else {
      entry.body.insertBefore(node.list, entry.receipt);
    }
    entry.attachments = node.list;
    entry.attachmentsHandle = node.handle;
    entry.attachmentsLocal = Boolean(entry.attachmentFiles?.length);
    // The list is in the document now, so it finally has a width to be sized from.
    paintPending();
  }

  function updateReceipt(entry, uttId) {
    entry.receipt.textContent = answered.has(uttId) ? "已回答" : "已交给房间";
    if (recordLost.has(uttId) && !entry.lossNote) {
      const note = document.createElement("p");
      note.className = "answer-note";
      note.textContent = "这条消息已交给房间，但未能保存到房间记录。";
      entry.body.append(note);
      entry.lossNote = note;
    }
  }
  function appendImlogEntries(entries, { live = true } = {}) {
    const box = $("messages");
    const flushAmbient = () => {
      ambientFold = null;
    };
    const addAmbient = (e) => {
      if (!ambientFold) {
        const fold = document.createElement("details");
        fold.className = "ambient-records ambient-context-fold";
        fold.dataset.at = e.at || "";
        const summary = document.createElement("summary");
        const fragment = document.createElement("p");
        fold.append(summary, fragment);
        insertByTime(box, fold);
        ambientFold = { fold, summary, fragment, count: 0 };
      }
      ambientFold.count += 1;
      ambientFold.fold.dataset.at = e.at || ambientFold.fold.dataset.at;
      const latestSpeaker = e.speaker && e.speaker !== "V?" ? `${e.speaker}：` : "";
      const latest = `${latestSpeaker}${stripSpeakerPrefix(e.text, e.speaker)}`;
      ambientFold.fragment.textContent =
        ambientFold.count === 1 ? latest : `${ambientFold.fragment.textContent}\n${latest}`;
      if (ambientFold.count === 1) {
        ambientFold.fold.open = true;
        ambientFold.fold.classList.add("single");
        ambientFold.summary.replaceChildren(
          document.createTextNode(`1 条房间声音 · ${fmtAt(e.at)}`)
        );
      } else {
        ambientFold.fold.open = false;
        ambientFold.fold.classList.remove("single");
        const count = document.createElement("span");
        count.textContent = `${ambientFold.count} 条房间声音`;
        const preview = document.createElement("span");
        preview.className = "ambient-records-preview";
        preview.textContent = latest;
        ambientFold.summary.replaceChildren(count, preview);
      }
    };
    for (const e of entries || []) {
      const key =
        e.utt_id && e.kind === "typed"
          ? `typed:${e.utt_id}`
          : `${e.at || ""}|${e.kind || ""}|${e.text || ""}`;
      if (renderedImlogKeys.has(key)) continue;
      renderedImlogKeys.add(key);
      if (e.kind === "typed") {
        flushAmbient();
        appendLocalMessage(e.text, e);
        continue;
      }
      const mine = e.kind === "answer" || e.speaker === "多多";
      if (!mine && e.kind === "human") {
        addAmbient(e);
        continue;
      }
      flushAmbient();
      /**
       * Final imlog rows replace matching live previews. Keep an unmatched preview rather than
       * discarding content that may never have been persisted.
       */
      const previous = mine && live ? dropSaidPreview(e.text, e.truncated) : null;
      // Anonymous `V<n>` is the persisted speaker; this page has no name source and invents none.
      const { row, body } = messageRow(
        mine ? "多多" : e.speaker || "房间",
        mine ? (e.truncated ? "部分播报" : "已在房间播报") : "语音",
        fmtAt(e.at),
        mine
      );
      row.dataset.at = e.at || "";
      if (previous?.process) body.append(previous.process);
      body.append(
        textBlock([
          e.truncated && previous?.previewText ? previous.previewText.textContent : e.text
        ])
      );
      if (previous?.interruption) body.append(previous.interruption);
      if (e.truncated) {
        const note = document.createElement("p");
        note.className = "answer-note";
        note.textContent = "这条没有播完。";
        body.append(note);
      }
      if (previous?.dataset.speechId) {
        const speech = previews.get(previous.dataset.speechId);
        if (speech) {
          speech.row = row;
          speech.persisted = true;
        }
        row.dataset.speechId = previous.dataset.speechId;
      }
      insertByTime(box, row);
    }
  }

  /**
   * A locally submitted message has no author: a shared screen cannot know who typed it. The row
   * appears only once the server accepted the submission — a failed send stays in the composer.
   */
  function appendLocalMessage(text, receipt = {}) {
    const uttId = receipt.utt_id;
    if (receipt.record_available === false) recordLost.add(uttId);
    const existing = uttId ? typedRows.get(uttId) : null;
    if (existing) {
      setAttachments(existing, receipt.attachments, receipt.files);
      updateReceipt(existing, uttId);
      return existing.row;
    }
    // A voice note takes the typed path too, but it was spoken, not typed on this page.
    const { row, body } = messageRow(
      "",
      receipt.voice_source ? "语音便签" : "本页输入",
      receipt.at ? fmtAt(receipt.at) : fmtNow(),
      false
    );
    row.dataset.at = receipt.at || new Date().toISOString();
    if (uttId) row.dataset.uttId = uttId;
    body.append(textBlock([text]));
    const status = document.createElement("p");
    status.className = "receipt";
    body.append(status);
    const entry = { row, body, receipt: status };
    if (uttId) typedRows.set(uttId, entry);
    updateReceipt(entry, uttId);
    insertByTime($("messages"), row);
    // Attach only once the row is in the column: a node outside the document measures no width,
    // and the decode is sized from layout.
    setAttachments(entry, receipt.attachments, receipt.files);
    return row;
  }

  /* Distinguish answers from fillers visually; use local arrival time for live speech frames. */
  let saidEl = null;
  const previews = new Map();
  /* Remove a matching live preview when its persisted final row arrives. */
  function dropSaidPreview(finalText, truncated = false) {
    const box = $("messages");
    if (!box) return;
    const final = String(finalText ?? "").trim();
    if (!final) return;
    for (const el of box.querySelectorAll("[data-said-preview]")) {
      const shown = (el.textContent || "").trim();
      if (!shown || !(final.startsWith(shown) || (truncated && shown.startsWith(final)))) continue;
      if (el === saidEl) {
        saidEl = null;
      }
      /**
       * Remove the row, not the text inside it. The preview carries its own 「正在说」 header, so
       * dropping only the text leaves an empty header above the persisted row and the finished
       * answer reads as two entries.
       */
      const previous = el.closest(".message") ?? el;
      previous.remove();
      return previous;
    }
  }

  function renderInterrupted(m) {
    const row = m.speech_id ? previews.get(m.speech_id)?.row : saidEl?.closest(".message");
    if (row === saidEl?.closest(".message")) saidEl = null;
    if (!row) return;
    const note = document.createElement("p");
    note.className = "interrupted";
    note.textContent = m.heard ? `被打断，听到「${m.heard}」为止。` : "被打断。";
    row.interruption = note;
    row.children[0].append(note);
  }

  function renderDuoduoSaid(m, final = false) {
    const box = $("messages");
    const known = m.speech_id ? previews.get(m.speech_id) : null;
    if (known && !known.persisted) {
      if (final) {
        known.finalText = m.text;
        known.origin.textContent = "已生成";
      } else known.streamText += m.text || "";
      known.text.textContent = known.finalText ?? known.streamText;
      saidEl = known.text;
      followLatest(box);
      return;
    }
    const next = foldDuoduoSaid(null, m);
    const isReaction = next.kind === "reaction";
    const { row, body } = messageRow("多多", final ? "已生成" : "正在生成", fmtNow(), true);
    row.dataset.at = new Date().toISOString();
    if (m.speech_id) row.dataset.speechId = m.speech_id;
    const said = document.createElement("div");
    said.className = "message-text" + (isReaction ? " reaction" : "");
    said.dataset.saidPreview = "1";
    said.textContent = next.text;
    row.previewText = said;
    if (!isReaction && turnBox && (!turnBox.parentElement || turnBox.parentElement === box)) {
      row.process = turnBox;
      body.append(turnBox);
    }
    body.append(said);
    box.append(row);
    if (m.speech_id)
      previews.set(m.speech_id, {
        row,
        text: said,
        origin: body.children[0].children[1],
        streamText: final ? "" : next.text,
        finalText: final ? next.text : undefined
      });
    saidEl = said;
    followLatest(box);
  }

  let turnBox = null;
  let turnUtt = null;
  const turnBoxes = new Map();
  function renderTurn(m) {
    if (!TURN_LABEL[m.phase]) return;
    if (m.phase === "received" && m.utt_id !== turnUtt) {
      turnUtt = m.utt_id;
      turnBox = turnBoxes.get(turnUtt);
      if (!turnBox) {
        turnBox = document.createElement("details");
        turnBox.className = "process";
        turnBox.hidden = true;
        turnBox.dataset.at = m.at || new Date().toISOString();
        const summary = document.createElement("summary");
        summary.textContent = "处理过程";
        turnBox.append(summary);
        turnBoxes.set(turnUtt, turnBox);
      }
    }
    if (m.phase !== "tool") return;
    if (!turnBox) {
      turnBox = document.createElement("details");
      turnBox.className = "process";
      turnBox.dataset.at = new Date().toISOString();
      const summary = document.createElement("summary");
      summary.textContent = "处理过程";
      turnBox.append(summary);
    }
    turnBox.hidden = false;
    if (!turnBox.parentElement) insertByTime($("messages"), turnBox);
    const line = document.createElement("div");
    line.className = "process-step";
    let label = m.input_summary || "使用工具";
    if (typeof label === "string" && label.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(label);
        const summary =
          parsed && typeof parsed === "object"
            ? parsed.description ||
              parsed.command ||
              parsed.file_path ||
              parsed.path ||
              parsed.query
            : parsed;
        label = typeof summary === "string" && summary.trim() ? summary.trim() : "使用工具";
      } catch {
        label = "使用工具";
      }
    }
    if (turnBox.lastElementChild?.textContent === label) return;
    line.textContent = label;
    turnBox.append(line);
  }

  let segCount = 0;
  /** Split transcript rows can share a timestamp, so use `utt_id` when one is available. */
  const transcriptRows = new Map();
  const dates = new Set();
  let recordQuery = "";

  function addDateBoundary(date) {
    if (dates.has(date)) return;
    dates.add(date);
    const boundary = document.createElement("p");
    boundary.className = "date-boundary";
    boundary.textContent = date;
    boundary.dataset.at = new Date(`${date}T00:00:00`).toISOString();
    insertByTime($("messages"), boundary);
  }

  function filterRecords(query) {
    recordQuery = query.trim().toLocaleLowerCase();
    for (const row of transcriptRows.values()) {
      row.hidden = Boolean(
        recordQuery && !row.textContent.toLocaleLowerCase().includes(recordQuery)
      );
    }
  }
  /**
   * Persisted `text` already carries its anonymous acoustic prefix (`"V1: ..."`), while `speaker`
   * repeats `V1`. Adding the chip without adapting that shape would render the label twice. Strip
   * only the prefix that matches this row, line by line; another row's prefix is content, not format.
   */
  function stripSpeakerPrefix(text, speaker) {
    const t = String(text ?? "");
    return t
      .split("\n")
      .map((line) => {
        const match = /^(V\?|V\d+)[：:]\s*/.exec(line);
        return match && (!speaker || match[1] === speaker) ? line.slice(match[0].length) : line;
      })
      .join("\n");
  }
  function appendTranscriptRow(row) {
    const d = document.createElement("div");
    d.className = "record-row";
    const at = document.createElement("time");
    at.textContent = fmtAt(row.at);
    const body = document.createElement("div");
    const speaker = document.createElement("p");
    speaker.className = "record-speaker";
    speaker.title = "说话人标签";
    speaker.textContent = row.speaker || "";
    const text = document.createElement("p");
    text.className = "record-text";
    text.textContent = stripSpeakerPrefix(row.text, row.speaker);
    body.append(speaker, text);
    d.append(at, body);
    d.dataset.at = row.at || "";
    const uttId = row.utt_id || `${row.at || ""}|${row.speaker || ""}|${row.text || ""}`;
    if (uttId) {
      const prev = transcriptRows.get(uttId);
      if (prev) {
        prev.remove();
        insertByTime($("record-list"), d);
        transcriptRows.set(uttId, d);
        filterRecords(recordQuery);
        return;
      }
      transcriptRows.set(uttId, d);
    }
    // Insert by event time because persisted replay and live delivery can arrive in different orders.
    const box = $("record-list");
    let ref = null;
    for (let n = box.lastElementChild; n; n = n.previousElementSibling) {
      if ((n.dataset.at || "") <= (d.dataset.at || "")) break;
      ref = n;
    }
    box.insertBefore(d, ref);
    segCount += 1;
    $("record-count").textContent = `已保留 ${segCount} 条房间记录`;
    filterRecords(recordQuery);
  }

  /** Frames this column renders; state frames are handled by the transport. */
  function handleFrame(m) {
    switch (m.type) {
      case "imlog_append":
        appendImlogEntries(m.entries);
        break;
      case "transcript":
        appendTranscriptRow(m.row || {});
        break;
      case "duoduo_said":
        renderDuoduoSaid(m);
        break;
      case "tts_interrupted":
        renderInterrupted(m);
        break;
      case "answer_final":
        if (m.utt_id) {
          answered.add(m.utt_id);
          const row = typedRows.get(m.utt_id);
          if (row) updateReceipt(row, m.utt_id);
        }
        if (m.text) renderDuoduoSaid({ ...m, kind: "answer" }, true);
        break;
      case "playback": {
        const preview = previews.get(m.speech_id);
        if (preview && m.state === "playing" && m.played_ms > 0)
          preview.origin.textContent = "正在说";
        if (preview && m.state === "done") preview.origin.textContent = "播报结束";
        break;
      }
      case "record_unavailable": {
        recordLost.add(m.utt_id);
        const row = typedRows.get(m.utt_id);
        if (row) updateReceipt(row, m.utt_id);
        break;
      }
      case "understood":
      case "wake_ignored":
      case "ack_silenced": {
        if (m.type === "understood" && m.addressed !== false) break;
        const note = document.createElement("p");
        note.className = "record-note";
        note.dataset.at = m.at || new Date().toISOString();
        note.textContent =
          m.type === "ack_silenced" ? "听到了，这次没有另外回应。" : "听到了，不是在叫我。";
        const fold = document.createElement("details");
        fold.className = "ambient-records";
        fold.dataset.at = note.dataset.at;
        const summary = document.createElement("summary");
        summary.textContent = `房间记录 · ${fmtAt(note.dataset.at)}`;
        fold.append(summary, note);
        insertByTime($("messages"), fold);
        break;
      }
      case "turn":
        renderTurn(m);
        break;
      default:
        break;
    }
  }

  return {
    handleFrame,
    appendImlogEntries,
    appendTranscriptRow,
    appendLocalMessage,
    addDateBoundary,
    filterRecords,
    onScroll,
    scrollLatest,
    refollow
  };
}
