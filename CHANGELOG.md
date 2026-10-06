# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, a minor version may change
the public API.

A change that makes saved reading specs read differently raises `SPEC_VERSION`. Specs of an older
version are set aside and written again on the next document of their layout; this is always
called out below.

## [0.1.0] - 2026-10-06

First release.

- `createReader`: reads a PDF with a saved reading spec, or has a model write one for a new layout
- The reading spec vocabulary (version 4): records, columns, labels, charges, lines and checks
- The proof: every amount accounted for, and sum, record and carry checks compared to the cent
- A repair loop that tells the model exactly which check failed, with the printed lines behind it
- `fileStore` and `memoryStore`
- `crossfoot/anthropic`: Claude as the model
- `ocrPage`: OCR words to positioned text, with tilt correction
- `parseAmount`
- The `crossfoot` command line
- Two example documents with their specs
