---
name: macos-fs-is-case-insensitive
description: The Mac checkout's filesystem is case-insensitive; writing cardDrawer.tsx next to CardDrawer.tsx silently overwrites the component
metadata:
  type: reference
---

The worktree lives on a case-insensitive APFS volume. A new file whose name
differs from an existing one only by case (`cardDrawer.tsx` beside
`CardDrawer.tsx`) is the SAME file: the Write tool reports "updated", not
"created", and the original component is gone.

**Why:** hit while extracting a drawer hook out of the collection page; the
tell was the Write result saying "updated successfully" for a file meant to
be new.

**How to apply:** before creating a file, `ls | grep -i <name>` in its folder,
and pick a name that differs by more than case (`drawerControl.tsx`). If a
Write says "updated" for a new file, restore the original from
`git show HEAD:<path>` at once. Git on Linux CI would also see two paths, so
never ship case-only twins. See [[gates-in-a-shared-worktree]].
