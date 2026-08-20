function timestamp() {
  return new Date().toISOString();
}

export function log(...args) {
  console.log(timestamp(), ...args);
}

export function logError(...args) {
  console.error(timestamp(), ...args);
}
