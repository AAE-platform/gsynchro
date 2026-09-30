# File identity and safe reconciliation — design notes

Status: experimental implementation in gsynchro 0.1.21. Recorded on 2026-09-30.

## Why this came up

Synchronization became confusing around deletions and moves. One contributing case was an agent converting Markdown files to DOCX. A `.md` then disappears while a `.docx` appears; DOCX is not in the default synchronized extension list, so the current path-based logic may see only a Markdown deletion.

The `tasks/WARNING.md` incident also showed a separate problem: the watcher reported an unlink on the destination, but reconciliation stopped while reading another destination file (`tasks/1_ready/M2E-TASK-001-report-sensor-context.md`) with `EIO`. The unreadable file blocked the whole scan. A read error must never be interpreted as a deletion.

## Identity convention

We first considered renaming managed files to `{name}.gs{id}.{ext}`. This would make moves recognizable, but changes every filename and can break links. The current preference is to leave filenames alone and add an identity footprint **only to Markdown files**.

The experiment leaves filenames unchanged and adds this footprint only to Markdown files:

```md
<!-- gsynchro:v1 id=550e8400-e29b-41d4-a716-446655440000 registered=2026-09-29T14:30:00Z -->
```

- Use a stable GUID as the identity. `registered` records when gsynchro first manages the file, not when the document was authored.
- Put the comment between YAML frontmatter and the document content. If there is no frontmatter, put it at the beginning. Frontmatter remains the first block for tools that parse it.
- Keep the ID unchanged when content, filename, or directory changes. Agents should preserve this comment.
- The comment is hidden in rendered Markdown. It is an aid to reconciliation, not a substitute for saved synchronization state.

## Intended reconciliation rules

1. When a new Markdown file appears in the repository, gsynchro adds the footprint during the scan before copying it to Drive.
2. When a new Markdown file appears only on Drive, gsynchro adds the footprint on Drive, then copies that updated file to the repository. A same-path file already registered in the repository supplies the ID to avoid a collision.
3. Pair repository and destination copies by ID, then track each side's path and content hash. A matching ID at a new path indicates a move or rename. Full ID-based move planning is the next experiment; the current release still plans operations by path.
4. If a previously tracked file loses its footprint, the current experiment assigns a new ID; restoring an old ID from saved state remains a follow-up improvement.
5. If the same ID occurs in two files on one side, stop and report the duplication. A copied document intended to become a separate file needs a fresh ID.
6. Interpret absence as deletion only after a complete, successful scan of the relevant side. An `EIO` or other unreadable file is an error, not evidence of absence.
7. Preserve the existing conflict policy: the repository currently wins simultaneous changes.

## Format conversion and open decisions

A Markdown comment may be lost when an agent converts the document to DOCX. Consider detecting a disappearing `.md` alongside a new `.docx` and suspending the deletion with a clear diagnostic. This needs a policy for whether DOCX should be synchronized, how conversions are linked to the original Markdown identity, and what to do when both formats remain.

Before implementation, decide how to migrate existing Markdown files without creating surprising mass edits, how to handle files copied with the same footprint, and how to recover if state is reset or multiple gsynchro processes scan the same pair concurrently. The footprint helps identify moves; it does not fix filesystem read errors or make an unreadable Drive file safe to delete.
