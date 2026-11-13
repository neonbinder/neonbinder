---
name: fastapi-manual-body-routes
description: A preprocess FastAPI route that takes two content types (JSON or multipart) reads Request by hand; starlette's form file fails isinstance(fastapi.UploadFile), and an openapi_extra $ref to an unused model dangles
metadata:
  type: reference
---

One FastAPI path cannot declare both a JSON body model and multipart fields, so
`/render-edit` (NEO-481) takes `request: Request` and dispatches on the
content type. Two traps:

- `await request.form()` hands back `starlette.datastructures.UploadFile`.
  `fastapi.UploadFile` subclasses it, so `isinstance(part, fastapi.UploadFile)`
  is False and every upload reads as missing. Check against the starlette class.
- A model read only by `Model.model_validate(await request.json())` never
  reaches FastAPI's components, so an `openapi_extra` requestBody `$ref` to it
  dangles silently and the snapshot test still passes. Register it (and its
  `$defs`, via `model_json_schema(ref_template="#/components/schemas/{model}")`)
  by wrapping `app.openapi`, then check the regenerated snapshot for refs with
  no component.

Related: Pillow's `Image.transform(AFFINE)` samples at pixel centres, so an
affine with an integer offset equals `crop()` byte for byte (bicubic and
bilinear both), and a continuous-coordinate box geometry maps onto it directly.

**How to apply:** any new preprocess route with a hand-read body; any renderer
built on Pillow transforms. See [[preprocess-pytest-runs-without-torch]] for
regenerating the snapshot locally.
