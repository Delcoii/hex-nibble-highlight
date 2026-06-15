# Change Log

All notable changes to the "hex-nibble-highlight" extension will be documented in this file.

## [0.1.0]

### Changed
- Run as a UI extension (`extensionKind: ui`) so rich copy uses the local Windows clipboard over Remote SSH.
- Added explicit activation events for C/C++/ASM/DAT languages.

## [0.0.3] - 2026-06-04

### Added
- **Rich copy (Windows):** Ctrl+C keeps VS Code syntax colors + nibble colors for Word/PowerPoint (`hex-nibble-highlight.richCopy`).

### Changed
- CF_HTML clipboard patch with header offset recalc (fixes Word/PPT paste truncation).

## [0.0.2]

### Changed
- Skip nibble highlight in inactive `#if` / `#ifdef` branches (still colors active code).

## [0.0.1]

### Added
- Editor nibble colors for `0x` literals in C/C++ (4-digit groups from the right).
- Skip hex in line and block comments.
