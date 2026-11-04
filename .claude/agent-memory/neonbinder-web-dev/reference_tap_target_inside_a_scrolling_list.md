---
name: reference-tap-target-inside-a-scrolling-list
description: A negative-margin 44px tap target past its tile's edge makes an overflow-auto lane scroll; extend it upward and keep the bottom inside the tile's padding
metadata:
  type: reference
---

Growing a small action to 44px with symmetric negative margins pushes the target past the tile. Inside an `overflow-auto` list, that overflow on the last tile gives the list a few pixels of scroll. Extend up over non-interactive text and down only as far as the tile's padding and border. Add `relative` so the target hit-tests above the text it overlaps. Check with `elementFromPoint` and `scrollHeight` against `clientHeight` ([[reference_static_markup_visual_check]]). NEO-427 `PHOTO_ACTION`.
