# Vendored dependencies

## SheetJS CE 0.20.3

- File: `xlsx-0.20.3.tgz`
- Official source: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
- Package name/version verified from the archive: `xlsx@0.20.3`
- SHA-256: recorded in `SHA256SUMS`

Verify the committed archive before installing:

```bash
sha256sum --check vendor/SHA256SUMS
npm ci
```

Do not replace the archive without updating the checksum, lockfile, parser regression tests,
and the security remediation review record.
