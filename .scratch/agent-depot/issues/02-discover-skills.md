# Discover Skills from selected Sources

Status: ready-for-agent
Blocked by: 01 Manage Sources before discovery

## What to build

Let users explicitly choose registered or built-in Sources before discovery and see recognized portable Skill candidates. Discovery recursively finds valid portable Skills, excludes explicitly lifecycle-marked subtrees, and does not modify Source content. Discovery must not automatically select or install candidates.

## Acceptance criteria

- Users explicitly choose the registered or built-in Sources to scan before discovery starts.
- Discovery recognizes portable directory Skills with SKILL.md containing the required name and description.
- Discovery recursively finds recognized Skill candidates within the selected Sources.
- Lifecycle-marked subtrees, including examples such as in-progress, beta, deprecated, or retired, are excluded from ordinary discovery results.
- Discovery does not modify Source content.
- Recognized candidates are shown without being automatically selected.
- Recognized candidates are not automatically installed.
