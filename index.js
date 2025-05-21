const ByteBuffer = require("bytebuffer");
const EventEmitter = require("events").EventEmitter;
const { ShareCode } = require("globaloffensive-sharecode");
const SteamID = require("steamid");
const Util = require("util");
const { once } = require("events");

const Language = require("./language.js");
const Protos = require("./protobufs/generated/_load.js");

const STEAM_APPID = 730;

module.exports = GlobalOffensive;

Util.inherits(GlobalOffensive, EventEmitter);

function GlobalOffensive(steam) {
  if (
    steam.packageName != "steam-user" ||
    !steam.packageVersion ||
    !steam.constructor
  ) {
    throw new Error(
      "globaloffensive v2 only supports steam-user v4.2.0 or later."
    );
  } else {
    let [major, minor] = steam.packageVersion.split(".");
    if (major < 4 || (major == 4 && minor < 2)) {
      throw new Error(
        `globaloffensive v2 only supports steam-user v4.2.0 or later. ${steam.constructor.name} v${steam.packageVersion} given.`
      );
    }
  }

  this._steam = steam;
  this.haveGCSession = false;
  this._isInCSGO = false;

  this._steam.on("receivedFromGC", (appid, msgType, payload) => {
    if (appid != STEAM_APPID) {
      return; // we don't care
    }

    let isProtobuf = !Buffer.isBuffer(payload);
    let handler = null;

    if (this._handlers[msgType]) {
      handler = this._handlers[msgType];
    }

    let msgName = msgType;
    for (let i in Language) {
      if (Language.hasOwnProperty(i) && Language[i] == msgType) {
        msgName = i;
        break;
      }
    }

    this.emit(
      "debug",
      "Got " +
        (handler ? "handled" : "unhandled") +
        " GC message " +
        msgName +
        (isProtobuf ? " (protobuf)" : "")
    );
    if (handler) {
      handler.call(
        this,
        isProtobuf
          ? payload
          : ByteBuffer.wrap(payload, ByteBuffer.LITTLE_ENDIAN)
      );
    }
  });

  this._steam.on("appLaunched", (appid) => {
    if (this._isInCSGO) {
      return; // we don't care if it was launched again
    }

    if (appid == STEAM_APPID) {
      this._isInCSGO = true;
      if (!this.haveGCSession) {
        this._connect();
      }
    }
  });

  let handleAppQuit = (emitDisconnectEvent) => {
    if (this._helloInterval) {
      clearInterval(this._helloInterval);
      this._helloInterval = null;
    }

    if (this.haveGCSession && emitDisconnectEvent) {
      this.emit(
        "disconnectedFromGC",
        GlobalOffensive.GCConnectionStatus.NO_SESSION
      );
    }

    this._isInCSGO = false;
    this.haveGCSession = false;
  };

  this._steam.on("appQuit", (appid) => {
    if (!this._isInCSGO) {
      return;
    }

    if (appid == STEAM_APPID) {
      handleAppQuit(false);
    }
  });

  this._steam.on("disconnected", () => {
    handleAppQuit(true);
  });

  this._steam.on("error", (err) => {
    handleAppQuit(true);
  });
}

GlobalOffensive.prototype._connect = function () {
  if (!this._isInCSGO || this._helloTimer) {
    this.emit(
      "debug",
      "Not trying to connect due to " +
        (!this._isInCSGO ? "not in CS:GO" : "has helloTimer")
    );
    return; // We're not in CS:GO or we're already trying to connect
  }

  let sendHello = () => {
    if (!this._isInCSGO) {
      this.emit("debug", "Not sending hello because we're no longer in CS:GO");
      delete this._helloTimer;
      return;
    } else if (this.haveGCSession) {
      this.emit("debug", "Not sending hello because we have a session");
      clearTimeout(this._helloTimer);
      delete this._helloTimer;
      return;
    }

    this._send(Language.ClientHello, Protos.CMsgClientHello, {
      version: 2000244,
      client_session_need: 0,
      client_launcher: 0,
      steam_launcher: 0,
    });

    this._helloTimerMs = Math.min(60000, (this._helloTimerMs || 1000) * 2); // exponential backoff, max 60 seconds
    this._helloTimer = setTimeout(sendHello, this._helloTimerMs);
    this.emit(
      "debug",
      `Sending hello, setting timer for next attempt to ${this._helloTimerMs} ms`
    );
  };

  this._helloTimer = setTimeout(sendHello, 500);
};

GlobalOffensive.prototype._send = function (type, protobuf, body) {
  if (!this._steam.steamID) {
    return false;
  }

  let msgName = type;
  for (let i in Language) {
    if (Language[i] == type) {
      msgName = i;
      break;
    }
  }

  this.emit("debug", "Sending GC message " + msgName);

  if (protobuf) {
    this._steam.sendToGC(STEAM_APPID, type, {}, protobuf.encode(body).finish());
  } else {
    // This is a ByteBuffer
    this._steam.sendToGC(STEAM_APPID, type, null, body.flip().toBuffer());
  }

  return true;
};

GlobalOffensive.prototype.requestGame = function (shareCodeOrDetails) {
  if (typeof shareCodeOrDetails == "string") {
    shareCodeOrDetails = new ShareCode(shareCodeOrDetails).decode();
  }

  if (typeof shareCodeOrDetails != "object" || !shareCodeOrDetails) {
    throw new Error(
      "shareCodeOrDetails must be a sharecode or an object with properties matchId, outcomeId, token"
    );
  }

  let requiredProps = ["matchId", "outcomeId", "token"];
  requiredProps.sort();
  let extantProps = Object.keys(shareCodeOrDetails);
  extantProps.sort();
  if (extantProps.join() != requiredProps.join()) {
    throw new Error(
      "shareCodeOrDetails must be a sharecode or an object with properties matchId, outcomeId, token"
    );
  }

  this._send(
    Language.MatchListRequestFullGameInfo,
    Protos.CMsgGCCStrike15_v2_MatchListRequestFullGameInfo,
    {
      matchid: shareCodeOrDetails.matchId,
      outcomeid: shareCodeOrDetails.outcomeId,
      token: shareCodeOrDetails.token,
    }
  );
};

GlobalOffensive.prototype.requestLiveGames = function () {
  this._send(
    Language.MatchListRequestCurrentLiveGames,
    Protos.CMsgGCCStrike15_v2_MatchListRequestCurrentLiveGames,
    {}
  );
};

GlobalOffensive.prototype.requestRecentGames = function (steamid) {
  if (typeof steamid === "string") {
    steamid = new SteamID(steamid);
  }

  if (
    !steamid.isValid() ||
    steamid.universe != SteamID.Universe.PUBLIC ||
    steamid.type != SteamID.Type.INDIVIDUAL ||
    steamid.instance != SteamID.Instance.DESKTOP
  ) {
    return false;
  }

  this._send(
    Language.MatchListRequestRecentUserGames,
    Protos.CMsgGCCStrike15_v2_MatchListRequestRecentUserGames,
    {
      accountid: steamid.accountid,
    }
  );
};

GlobalOffensive.prototype.requestLiveGameForUser = function (steamid) {
  if (typeof steamid === "string") {
    steamid = new SteamID(steamid);
  }

  if (
    !steamid.isValid() ||
    steamid.universe != SteamID.Universe.PUBLIC ||
    steamid.type != SteamID.Type.INDIVIDUAL ||
    steamid.instance != SteamID.Instance.DESKTOP
  ) {
    return false;
  }

  this._send(
    Language.MatchListRequestLiveGameForUser,
    Protos.CMsgGCCStrike15_v2_MatchListRequestLiveGameForUser,
    {
      accountid: steamid.accountid,
    }
  );
};

GlobalOffensive.prototype.inspectItem = async function (owner, assetid, d) {
  let match;
  if (
    typeof owner === "string" &&
    (match = owner.match(/[SM](\d+)A(\d+)D(\d+)$/))
  ) {
    owner = match[1];
    assetid = match[2];
    d = match[3];
  }

  let msg = {
    param_a: assetid,
    param_d: d,
    param_s: 0,
    param_m: 0,
  };

  if (typeof owner === "object") {
    owner = owner.toString();
  }

  try {
    let sid = new SteamID(owner);
    if (
      !sid.isValid() ||
      sid.universe != SteamID.Universe.PUBLIC ||
      sid.type != SteamID.Type.INDIVIDUAL ||
      sid.instance != SteamID.Instance.DESKTOP
    ) {
      throw 0;
    }
    // it's a valid steamid
    msg.param_s = owner;
  } catch (e) {
    msg.param_m = owner;
  }

  this._send(
    Language.Client2GCEconPreviewDataBlockRequest,
    Protos.CMsgGCCStrike15_v2_Client2GCEconPreviewDataBlockRequest,
    msg
  );

  const [error, item] = await catchError(
    once(this, `inspectItemInfo#${assetid}`, {
      signal: AbortSignal.timeout(10 * 1000),
    })
  );

  if (!error)
    return [
      undefined,
      {
        paintIndex: item.paintindex,
        paintWear: item.paintwear,
        paintSeed: item.paintseed,
        stickers: item.stickers,
        keychains: item.keychains,
      },
    ];

  if (error.name === "AbortError") return [`inspectItemTimedOut`, undefined];
};

GlobalOffensive.prototype.requestPlayersProfile = function (steamid, callback) {
  if (typeof steamid == "string") {
    steamid = new SteamID(steamid);
  }

  if (
    !steamid.isValid() ||
    steamid.universe != SteamID.Universe.PUBLIC ||
    steamid.type != SteamID.Type.INDIVIDUAL ||
    steamid.instance != SteamID.Instance.DESKTOP
  ) {
    return false;
  }

  this._send(
    Language.ClientRequestPlayersProfile,
    Protos.CMsgGCCStrike15_v2_ClientRequestPlayersProfile,
    {
      account_id: steamid.accountid,
      request_level: 32,
    }
  );

  if (callback) {
    this.once("playersProfile#" + steamid.getSteamID64(), callback);
  }
};

/**
 * Rename an item in your inventory using a name tag.
 * @param {int} nameTagId
 * @param {int} itemId
 * @param {string} name
 */
GlobalOffensive.prototype.nameItem = function (nameTagId, itemId, name) {
  let buffer = new ByteBuffer(
    18 + Buffer.byteLength(name),
    ByteBuffer.LITTLE_ENDIAN
  );
  buffer.writeUint64(nameTagId);
  buffer.writeUint64(itemId);
  buffer.writeByte(0x00); // unknown
  buffer.writeCString(name);
  this._send(Language.NameItem, null, buffer);
};

/**
 * Permanently delete an item from your inventory.
 * @param {int} itemId
 */
GlobalOffensive.prototype.deleteItem = function (itemId) {
  let buffer = new ByteBuffer(8, ByteBuffer.LITTLE_ENDIAN);
  buffer.writeUint64(itemId);
  this._send(Language.Delete, null, buffer);
};

/**
 * Craft some items using a given recipe.
 * @param {int[]} items - IDs of items to craft
 * @param {int} recipe - The ID of the recipe to use
 */
GlobalOffensive.prototype.craft = function (items, recipe) {
  let buffer = new ByteBuffer(
    2 + 2 + 8 * items.length,
    ByteBuffer.LITTLE_ENDIAN
  );
  buffer.writeInt16(recipe);
  buffer.writeInt16(items.length);
  for (let i = 0; i < items.length; i++) {
    buffer.writeUint64(items[i]);
  }

  this._send(Language.Craft, null, buffer);
};

// Storage units
/**
 * Put an item from your inventory into a casket (aka a storage unit).
 * @param {int} casketId
 * @param {int} assetId
 */
GlobalOffensive.prototype.addToCasket = async function (casketId, assetId) {
  if (
    (typeof casketId !== "string" && typeof casketId !== "number") ||
    (typeof assetId !== "string" && typeof assetId !== "number")
  ) {
    throw new Error("TypeError: Expected string or number");
  }

  this._send(Language.CasketItemAdd, Protos.CMsgCasketItem, {
    casket_item_id: casketId,
    item_item_id: assetId,
  });

  const abortSignal = AbortSignal.timeout(5 * 1000);

  while (true) {
    const [error, itemId, notificationType] = await catchError(
      once(this, "itemCustomizationNotification", {
        signal: abortSignal,
      })
    );
    if (
      notificationType ===
      GlobalOffensive.itemCustomizationNotification.CasketTooFull
    )
      return [
        {
          message: `Casket ${casketId} is full`,
          id: GlobalOffensive.itemCustomizationNotification.CasketTooFull,
        },
        undefined,
      ];
    if (
      notificationType ===
      GlobalOffensive.itemCustomizationNotification.CasketAdded
    )
      return [undefined, itemId];
    if (error) return [error, undefined];
  }
};

/**
 * Remove an item from a casket (aka a storage unit) into your inventory.
 * @param {int} casketId
 * @param {int} assetId
 */
GlobalOffensive.prototype.removeFromCasket = async function (
  casketId,
  assetId
) {
  if (
    (typeof casketId !== "string" && typeof casketId !== "number") ||
    (typeof assetId !== "string" && typeof assetId !== "number")
  ) {
    throw new Error("TypeError: Expected string or number");
  }

  this._send(Language.CasketItemExtract, Protos.CMsgCasketItem, {
    casket_item_id: casketId,
    item_item_id: assetId,
  });

  const [error, removedItem] = await catchError(
    once(this, "itemAcquired", {
      signal: AbortSignal.timeout(5 * 1000),
    })
  );

  if (!error) return [undefined, removedItem];
  return [error, undefined];
};
/**
 * Get the contents of a casket (aka a storage unit).
 * @param {int} casketId
 * @
 */
GlobalOffensive.prototype.getCasketContents = async function (casketId) {
  if (typeof casketId !== "string" && typeof casketId !== "number") {
    throw new Error("TypeError: Expected string or number");
  }
  // First see if we already have this casket's contents in our inventory
  let casketItem = this.inventory.find((item) => item.id == casketId);
  if (!casketItem) {
    return [
      new Error(`No casket matching ID ${casketId} was found`),
      undefined,
    ];
  }

  if (!casketItem.casket_contained_item_count) {
    // Casket is empty, I guess
    return [undefined, []];
  }

  let loadedItems = this.inventory.filter((item) => item.casket_id == casketId);
  if (loadedItems.length == casketItem.casket_contained_item_count) {
    return [undefined, loadedItems];
  }

  // We need to load casket contents from the GC
  this._send(Language.CasketItemLoadContents, Protos.CMsgCasketItem, {
    casket_item_id: casketId,
    item_item_id: casketId,
  });

  const abortSignal = AbortSignal.timeout(15 * 1000);
  while (true) {
    const [error, itemIds, notificationType] = await catchError(
      once(this, "itemCustomizationNotification", {
        signal: abortSignal,
      })
    );
    if (error?.name === "AbortError") return [error, undefined];
    if (
      itemIds?.[0] != casketId ||
      notificationType !=
        GlobalOffensive.ItemCustomizationNotification.CasketContents
    )
      continue;
    if (!error)
      return [
        undefined,
        this.inventory.filter((item) => item.casket_id == casketId),
      ];
  }
};

function catchError(promise, errorsToCatch) {
  return promise
    .then((data) => {
      if (Array.isArray(data)) return [undefined, ...data];
      return [undefined, data];
    })
    .catch((error) => {
      if (errorsToCatch === undefined) return [error];
      if (errorsToCatch.some((e) => error instanceof e)) return [error];
      throw error;
    });
}

GlobalOffensive.prototype._handlers = {};

require("./enums.js");
require("./handlers.js");
