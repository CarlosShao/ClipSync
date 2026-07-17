# Concurrent File Upload Fix — Checklist

**Created:** 2026-07-10
**Goal:** Fix race condition where rapid consecutive file copies drop/lose uploads.

## Phase 1: Scan / Root Cause
- [x] Scan `useClipboard.ts` for concurrency control (none — only `isProcessingEvent` boolean lock that drops events).
- [x] Scan `clipboard_monitor.rs` for event emission (single-threaded, emits immediately on change).
- [x] Scan `clipboard.js` backend for concurrent insert handling (no explicit row locking; simple INSERT).
- [x] Identify `skipNextPolls(15000)` inside `uploadFileToServer` blocks subsequent external file events.
- [x] Identify `isProcessingEvent` drops concurrent clipboard events instead of queueing them.

## Phase 2: Fix
- [x] Replace `isProcessingEvent` boolean lock with a real upload queue in `useClipboard.ts`.
- [x] Make `handleClipboardEvent` enqueue captured payloads instead of awaiting upload inline.
- [x] Make `readAndUpload` fallback poll enqueue detected content instead of uploading inline.
- [x] Implement queue processor that serializes uploads one at a time (file/image/text).
- [x] Remove / reduce `skipNextPolls` inside `uploadFileToServer` so subsequent external copies are not dropped.
- [x] Reduce `copyItem` skip window to 3s to avoid dropping unrelated external copies.
- [x] Add deduplication inside queue (by file path, text content, image size).
- [x] Add debug logging for queue decisions.

## Phase 3: Verify
- [x] Run `vue-tsc --noEmit` in desktop directory.
- [x] Run `cargo check` in Rust directory.
- [x] Commit changes with descriptive message.
- [x] Report verification evidence.

**Result:** ✅ 8 / 8 fix items completed; committed as `46e738b`.
