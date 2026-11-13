---
name: photo-changes-reach-ebay-not-bsc
description: Any plan that changes a saved copy photo (replace, rotate, re-crop) must handle BSC explicitly; eBay re-uploads on a new photoToken, BSC uploads a seller photo only while the row still shows BSC's stock image; placeholder outputs are write-once, so an edited scan needs a versioned key
metadata:
  type: project
---

A new photo on a copy line reaches the listing destinations unevenly:

- **eBay** follows the photo: `commitUpload` queues the card (`queueIfHomeLists`), the
  drain compares `marketplaceListingLinks.images[].photoToken` with the live photo's
  token, re-uploads on a mismatch and revises the item (content hash).
- **BSC** does not: `lib/bscSheetPlan.ts` `rowNeedsSellerPhoto` uploads only when the
  sheet row's `sellerImgFront/Back` is null or BSC's "Default" image. Once a seller
  photo is set, NB never replaces it, so a Replace (NEO-377) or an edit (NEO-481) is
  silently invisible on BSC. NB stores no record of which photo it pushed to BSC.
- BSC lists one photo per (card, condition) group: the OLDEST copy with photos.
  Changing another copy's photo changes nothing on BSC by design.

Placeholder pipeline objects are write-once (`/process-entry` output and the
copy-photo sizes: first write wins, `ObjectAlreadyExistsError` is swallowed), and the
placeholder bucket keeps scans two days. A re-render of a scan needs a new, versioned
object key and a field saying which version is current; a saved card older than two
days has no original left. Jason (2026-11-09, NEO-481) chose NOT to keep originals in R2
("stay tidy"): a saved photo keeps only the 1600 px image and the thumb, because eBay's
Media API stores at most 1600 x 1600, so an edit after two days starts from that image.
Never plan a kept original or a stored size above eBay's stored maximum.

**Why:** found planning NEO-481 (rotate / manual crop, 2026-11-09). Jason decided an
edited photo must update "anything listing from it".

**How to apply:** a plan touching copy photos gives BSC a refresh path (e.g. a flag on
the `listingOutbox` row that makes the drain upload even over an existing seller
photo) and says whether BSC replaces an image when the PUT carries a new key (an
unverified marketplace shape until a seller run proves it). Related:
[[listing-specs-race-the-sales-poll]], [[seller-specs-race-background-drains]].
