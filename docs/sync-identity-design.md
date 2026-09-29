# File identity and safe reconciliation — design notes

Status: proposal, not implemented. Recorded on 2026-09-29 for the next design session.

## Why this came up

Synchronization became confusing around deletions and moves. One contributing case was an agent converting Markdown files to DOCX. A `.md` then disappears while a `.docx` appears; DOCX is not in the default synchronized extension list, so the current path-based logic may see only a Markdown deletion.

The `tasks/WARNING.md` incident also showed a separate problem: the watcher reported an unlink on the destination, but reconciliation stopped while reading another destination file (`tasks/1_ready/M2E-TASK-001-report-sensor-context.md`) with `EIO`. The unreadable file blocked the whole scan. A read error must never be interpreted as a deletion.

## Identity proposal

We first considered renaming managed files to `{name}.gs{id}.{ext}`. This would make moves recognizable, but changes every filename and can break links. The current preference is to leave filenames alone and add an identity footprint **only to Markdown files**.

Suggested footprint:

```md
<!-- gsynchro:v1 id=550e8400-e29b-41d4-a716-446655440000 registered=2026-09-29T14:30:00Z -->
```

- Use a stable GUID as the identity. `registered` records when gsynchro first managed the file, not when the document was authored.
- Put the comment near the top, after YAML frontmatter when present. Frontmatter must remain the first block for tools that parse it.
- Keep the ID unchanged when content, filename, or directory changes. Agents should preserve this comment.
- The comment is hidden in rendered Markdown. It is an aid to reconciliation, not a substitute for saved synchronization state.

## Intended reconciliation rules

1. Pair repository and destination copies by ID, then track each side's path and content hash. A matching ID at a new path indicates a move or rename.
2. When a genuinely new Markdown file has no footprint, assign an ID before synchronizing it. Coordinate assignment across both sides so the two copies of one file do not receive different IDs.
3. If a previously tracked file loses its footprint, restore its existing ID from saved state rather than assigning a new one.
4. If the same ID occurs in two files on one side, stop and report the duplication. A copied document intended to become a separate file needs a fresh ID.
5. Interpret absence as deletion only after a complete, successful scan of the relevant side. An `EIO` or other unreadable file is an error, not evidence of absence.
6. Preserve the existing conflict policy unless deliberately changed: the repository currently wins simultaneous changes.

## Format conversion and open decisions

A Markdown comment may be lost when an agent converts the document to DOCX. Consider detecting a disappearing `.md` alongside a new `.docx` and suspending the deletion with a clear diagnostic. This needs a policy for whether DOCX should be synchronized, how conversions are linked to the original Markdown identity, and what to do when both formats remain.

Before implementation, decide how to migrate existing Markdown files without creating surprising mass edits, how to handle files copied with the same footprint, and how to recover if state is reset or multiple gsynchro processes scan the same pair concurrently. The footprint helps identify moves; it does not fix filesystem read errors or make an unreadable Drive file safe to delete.
