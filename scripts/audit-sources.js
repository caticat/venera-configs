#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const index = JSON.parse(fs.readFileSync(path.join(repoRoot, "index.json"), "utf8"));

process.on("unhandledRejection", () => {});

class ComicSource {
  constructor() {
    this._data = {};
  }

  loadData(key) {
    return this._data[key];
  }

  saveData(key, value) {
    this._data[key] = value;
  }

  deleteData(key) {
    delete this._data[key];
  }

  loadSetting(key) {
    return this.settings?.[key]?.default;
  }
}

class Cookie {
  constructor(value) {
    Object.assign(this, value);
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const contextBase = {
  APP: {
    version: "1.6.0",
    locale: "zh_CN",
    platform: "windows",
  },
  ComicSource,
  Cookie,
  Network: {
    get() {
      return Promise.resolve({ status: 599, body: "" });
    },
    post() {
      return Promise.resolve({ status: 599, body: "" });
    },
    getCookies() {
      return [];
    },
    setCookies() {},
    deleteCookies() {},
  },
  Convert: {
    encodeUtf8(value) {
      return Buffer.from(value, "utf8");
    },
    decodeUtf8(value) {
      return Buffer.from(value).toString("utf8");
    },
    encodeBase64(value) {
      return Buffer.from(value).toString("base64");
    },
    decodeBase64(value) {
      return Buffer.from(value, "base64");
    },
    hmacString() {
      return "";
    },
    md5() {
      return "";
    },
  },
  DOMParser: class {},
  UI: {
    showMessage() {},
    showDialog() {},
  },
  console,
  fetch() {
    return Promise.resolve({
      ok: false,
      status: 599,
      text: async () => "",
      json: async () => ({}),
    });
  },
  randomInt,
  setTimeout,
};

let failed = false;

for (const item of index) {
  const filePath = path.join(repoRoot, item.fileName);
  const source = fs.readFileSync(filePath, "utf8");
  const classMatch = source.match(/class\s+([A-Za-z_$][\w$]*)\s+extends\s+ComicSource/);
  if (!classMatch) {
    console.log(`FAIL ${item.fileName}: no ComicSource class found`);
    failed = true;
    continue;
  }

  const className = classMatch[1];
  const context = vm.createContext({ ...contextBase });
  try {
    vm.runInContext(`${source}\nglobalThis.source = new ${className}();`, context, {
      filename: item.fileName,
    });
    if (typeof context.source.init === "function") {
      context.source.init();
    }
    const fileVersion = context.source.version;
    if (fileVersion !== item.version) {
      console.log(`MISMATCH ${item.fileName}: index=${item.version} file=${fileVersion}`);
      failed = true;
    } else {
      console.log(`OK ${item.fileName}`);
    }
  } catch (error) {
    console.log(`FAIL ${item.fileName}: ${error && error.stack ? error.stack : error}`);
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
