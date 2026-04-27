function nowISO() {
  return new Date().toISOString();
}

function logInfo(message) {
  // Keep log style close to the existing app.
  process.stdout.write(`[${nowISO()}] ${String(message)}\n`);
}

function logError(message) {
  process.stderr.write(`[${nowISO()}] ${String(message)}\n`);
}

module.exports = {
  logInfo,
  logError,
  nowISO,
};
