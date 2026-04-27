const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const ENV_PATHS = [
  // gnani-translator-desktop-pro/.env
  path.join(__dirname, '..', '..', '..', '.env'),
  // repo root .env (current primary location)
  path.join(__dirname, '..', '..', '..', '..', '.env'),
];

let ACTIVE_ENV_PATH = ENV_PATHS[0];
for (const p of ENV_PATHS) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    ACTIVE_ENV_PATH = p;
    break;
  }
}

function env(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}

module.exports = {
  env,
  ENV_PATH: ACTIVE_ENV_PATH,
  ENV_PATHS,
};
