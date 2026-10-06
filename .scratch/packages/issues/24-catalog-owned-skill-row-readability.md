# Catalog keeps active Package-owned Skill rows readable

Status: fixed and verified.

## Problem

Active Package-owned Skills appeared dim and their ownership explanation was
appended inline. Long Skill names, descriptions, or ownership text wrapped into
multiple physical terminal rows, making the Catalog difficult to scan and
increasing the height of each entry. A Package-owned Skill still needs a clear
owner explanation and must remain unavailable for loose installation.

## Fix

Keep each owned Skill row on one terminal line with end truncation, normal text
contrast, and a compact Package badge. Show the full ownership reason for the
highlighted Skill outside its row. Retain the existing refusal for marking or
installing an owned Skill as loose, and apply bulk marking or installation only
to loose Skills.

## Verification

- `tests/tui-catalog-view.test.tsx` checks one-line output at widths 40, 80, and
  120, after a narrow resize with Unicode and an unmanaged marker, readable
  contrast, and owned-Skill action refusals.
- The Catalog view reserves a row for the full ownership notice.
- Focused Ink render tests and the real-PTY end-to-end suite pass.
