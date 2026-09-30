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
3. Pair repository and destination copies by ID, then track each side's path and content hash. `.gsynchro/gsynchro.status` stores the identity at each path and the identity inside each side's snapshot, so a later scan can compare an old path with a newly appearing path. A matching unique ID at a new path indicates a move or rename. Full ID-based move planning is the next experiment; the current release still plans operations by path.
4. If a previously tracked file loses its footprint, the current experiment assigns a new ID; restoring an old ID from saved state remains a follow-up improvement.
5. If the same ID occurs in two files on one side, stop and report the duplication. A copied document intended to become a separate file needs a fresh ID.
6. Interpret absence as deletion only after a complete, successful scan of the relevant side. An `EIO` or other unreadable file is an error, not evidence of absence.
7. Preserve the existing conflict policy: the repository currently wins simultaneous changes.

## Format conversion and open decisions

A Markdown comment may be lost when an agent converts the document to DOCX. Consider detecting a disappearing `.md` alongside a new `.docx` and suspending the deletion with a clear diagnostic. This needs a policy for whether DOCX should be synchronized, how conversions are linked to the original Markdown identity, and what to do when both formats remain.

Before implementation, decide how to migrate existing Markdown files without creating surprising mass edits, how to handle files copied with the same footprint, and how to recover if state is reset or multiple gsynchro processes scan the same pair concurrently. The footprint helps identify moves; it does not fix filesystem read errors or make an unreadable Drive file safe to delete.

## Configuration and side-local state

The repository remains authoritative for configuration. At startup and during reconciliation, gsynchro writes a generated copy to `destination/.gsynchro/gsynchro.yml`. The copy contains an explicit comment explaining that it is generated from the repository, which paths and extensions are synchronized, and that other Drive files remain Drive-only. It is metadata for people and agents working in Drive; edits are overwritten by the repository configuration.

The generated configuration mirror and side-local status files are excluded from normal file synchronization. A delete or edit event for the Drive mirror causes the next reconciliation to restore it. The repository status and a future Drive status may contain different local observations; they are evidence used together, not two competing configuration sources.

Each machine creates a local `.gsynchro/machine-id.json`, ignored by Git. Every status history entry records that machine ID, a synchronization ID, timestamp, triggering filesystem events, operations, and the result. The repository status describes the full local comparison; `destination/.gsynchro/gsynchro.status` describes the Drive-side snapshots and keeps a bounded history from whichever machine last wrote it. This is diagnostic evidence only: it does not block a second machine or provide a distributed lock.

Status files use the existing `version: 1` format with optional identity and history fields, so an older status is accepted and enriched after a successful run. Deleting a status resets the synchronization baseline and can cause a later run to copy a file that had previously been deleted; the status should be backed up before a deliberate reset. The machine ID and Markdown footprints remain independent of that reset.

The two `.trash/` directories remain useful alongside status history. A propagated deletion is moved there when possible, giving a recoverable copy after an incorrect decision or status reset. Trash is never synchronized and does not protect a file deleted manually before gsynchro observes it.
