# Third-party files (bundled so the app never loads code from another website)

| Folder | Package | Version | License | Used for |
|---|---|---|---|---|
| `pdfjs/` | pdfjs-dist (legacy build, minified) | 4.4.168 | Apache-2.0 | reading text from PDF bills |
| `tesseract/` (`tesseract.min.js`, `worker.min.js`) | tesseract.js | 5.1.1 | Apache-2.0 | OCR for photos and scanned bills |
| `tesseract/core/` | tesseract.js-core | 5.1.1 | Apache-2.0 | OCR engine (WebAssembly) |
| `tesseract/lang/eng.traineddata.gz` | @tesseract.js-data/eng (4.0.0_best_int) | 1.0.0 | Apache-2.0 | English OCR model |

They are loaded only when you tap **Import card bill**. Files you choose are processed on the phone and never uploaded.
