# IHatePDF v1.3.0

Big files use a fraction of the memory they did, the app protects the PC it runs on from running out of memory, and Hindi, Marathi, Chinese and Japanese text now works in every tool that writes text.

## Install

1. Download **IHatePDF-Setup.exe** below, under *Assets*.
2. Run it. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The installer isn't code-signed.
3. Windows asks once for **administrator permission** (for the Share to phone firewall rule).

**Updating from 1.1.0 or 1.2.0:** just run the new setup. It replaces the old version, including a 1.1.0 installed for your own Windows account only. The one case it can't clean up: 1.1.0 installed under a *different* Windows account than the one installing 1.3.0. That copy stays in that account's *Settings → Apps* and can be uninstalled there.

## Much less memory for big files

Files are no longer read into memory whole. Tools read the parts of a PDF they need from disk and write the result to disk as they go, so memory stays roughly the same whether a file is 5 MB or 2 GB.

| Job (measured in the desktop app) | 1.2.0 | 1.3.0 |
|---|---|---|
| Watermark a 500 MB PDF | 5.2 GB | 0.9 GB |
| Rotate a 500 MB PDF | 4.7 GB | 1.6 GB |
| Redact 5,000 pages | 8.3 GB | 1.2 GB |
| Compress a 2 GB PDF | — | 1.1 GB |
| Excel→PDF, 100,000 rows | 4.3 GB | 1.9 GB |
| Merge two 5,000-page PDFs | 13 s | 3.6 s |

- **Thumbnails** are drawn only for the pages on screen, so a 5,000-page file opens straight away in Organize, Rotate, Split, PDF→JPG and the editor.
- **Redact** draws and saves one page at a time.
- **Compare** keeps only the page images near what you're looking at.
- **Compress** skips any single image too large to decode safely, and says which.
- **PDF→Markdown** shows the start of very long results on screen; the saved file and **Copy** include everything.

## Memory fail-safe

IHatePDF now gives itself a memory budget based on the PC's RAM, leaving the rest for Windows and other programs:

| PC's RAM | IHatePDF uses at most |
|---|---|
| 4 GB | 1 GB |
| 6 GB | 3 GB |
| 8 GB | 4 GB |
| 16 GB | 8 GB |
| 32 GB or more | 16 GB |

Near the budget, tools slow down and work in smaller pieces. If a job would go over it anyway, or Windows itself is running out of memory, the job stops with *"Stopped to protect this PC"* and the app stays usable. If the window stops responding while using too much memory, it is restarted and says why, before Windows itself runs short.

## Hindi, Marathi, Chinese and Japanese

Edit PDF, Watermark, Page numbers, Fill forms, and Word, Excel, PowerPoint and HTML to PDF now write Devanagari (Hindi, Marathi) with correctly joined letters and vowel signs, and Chinese and Japanese characters. Text that mixes scripts, like Hindi with English words, works too. The fonts ship inside the app (Noto Sans, Open Font License), so it works offline.

## Also fixed

- **PDF→Word keeps pictures**: photos and figures appear in the Word file where they were on the page.
- **Tables** in PDF→Word and PDF→Excel are detected more reliably, including tables with narrow gaps between columns.
- **Crashes:** if a window crashes, it reloads with a short note instead of staying blank. Repeated crashes close the app with a message.
- **Damaged files** get a plain explanation instead of a technical error: that the file is damaged and to run it through Repair PDF first, or that it was moved or deleted after you added it.
- **Share to phone:** folders containing files that can't be read (in use, no permission, or shortcut loops) no longer fail. Those files are skipped and listed.
- The Windows build checks that everything it needs is included before the installer is made.

## Known limits

- Password-protected PDFs are decrypted into memory when opened, so they need about twice their size in RAM.
- On a 4 GB PC, very large jobs (a 1 GB+ image PDF) may be stopped by the fail-safe. Nothing crashes; the job just doesn't run.
- Repairing a large damaged file reads it whole, so it needs several times the file's size in RAM (a 450 MB file: about 3 GB).
- One piece of text that mixes Hindi/Marathi with Chinese/Japanese (for example a single watermark with both) shows only the first script's characters. Each script on its own, or mixed with English, works; Edit PDF handles any mix.
- Scanned pages have no text to edit or convert (there's no OCR).
- Signing adds a visible signature, not a certificate-based digital signature.

Earlier changes: [v1.2.0 release notes](https://github.com/Burthcer/IHatePDF/releases/tag/v1.2.0).
