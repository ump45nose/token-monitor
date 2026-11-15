'use strict';

// macOS arm64 build for the fork's own GitHub releases. The fork has no Apple
// Developer ID, so the app is ad-hoc signed unless CSC_LINK provides a
// certificate (keep the same certificate across releases if you add one:
// Squirrel.Mac only installs an update whose signature satisfies the running
// app's designated requirement, which an ad-hoc signature never does).
const base = require('../scripts/electron-builder.config.js');

const hasCertificate = Boolean(process.env.CSC_LINK);

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    forceCodeSigning: false,
    notarize: false,
    ...(hasCertificate ? {} : { identity: '-' })
  }
};
