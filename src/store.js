/**
 * store.js — 本地持久化层（纯函数，注入 storage，因此可在 Node 中单测）
 *
 * 两类数据：
 *   sc.peers    已知设备： { "<peerId>": { id, name, lastAt } }
 *   sc.history  会话记录： { peers: { "<peerId>": [ {k,t,m,a}, … ] } }
 *
 * 历史按 peerId 分组。**以 peerId 为主键、昵称为显示名**：
 * 对方一旦重置浏览器数据/换浏览器/用无痕模式，peerId 就会变，
 * 历史会断成"新设备"——这是这套方案的已知代价，不做伪造的稳定指纹。
 *
 * 按用户要求：不做 v1 扁平数组的迁移，检测到旧格式直接丢弃重建。
 */

export const HISTORY_MAX = 300;

const HISTORY_KEY = 'sc.history';
const PEERS_KEY = 'sc.peers';

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 配额满 / 隐私模式：不影响聊天本身
    return false;
  }
}

/* ============================ 会话记录 ============================ */

/** @returns {{peers: Record<string, Array>}} */
export function loadHistory(storage) {
  const v = readJson(storage, HISTORY_KEY, null);
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.peers !== 'object' || v.peers === null) {
    return { peers: {} }; // 含 v1 旧格式：直接丢弃重建
  }
  return v;
}

/** 某个设备的记录（副本） */
export function peerHistory(storage, peerId) {
  const h = loadHistory(storage);
  const arr = h.peers[String(peerId)];
  return Array.isArray(arr) ? arr.slice() : [];
}

/** 追加一条记录，超过上限从头丢弃 */
export function appendHistory(storage, peerId, entry) {
  const h = loadHistory(storage);
  const k = String(peerId);
  const arr = Array.isArray(h.peers[k]) ? h.peers[k] : (h.peers[k] = []);
  arr.push(entry);
  while (arr.length > HISTORY_MAX) arr.shift();
  return writeJson(storage, HISTORY_KEY, h);
}

export function clearPeerHistory(storage, peerId) {
  const h = loadHistory(storage);
  delete h.peers[String(peerId)];
  return writeJson(storage, HISTORY_KEY, h);
}

export function clearAllHistory(storage) {
  try {
    storage.removeItem(HISTORY_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 有记录的设备 id 列表 */
export function historyPeerIds(storage) {
  return Object.keys(loadHistory(storage).peers);
}

/* ============================ 已知设备 ============================ */

/** @returns {Record<string, {id:number,name:string,lastAt:number}>} */
export function loadPeers(storage) {
  const v = readJson(storage, PEERS_KEY, null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return v;
}

/** 记住一台连接成功的设备（昵称可被后续覆盖） */
export function rememberPeer(storage, id, name, at = Date.now()) {
  const peers = loadPeers(storage);
  const k = String(id);
  const prev = peers[k] || {};
  peers[k] = {
    id,
    name: name || prev.name || `设备${id}`,
    lastAt: at,
  };
  writeJson(storage, PEERS_KEY, peers);
  return peers[k];
}

/** 手动改对端昵称（用户要求：允许改） */
export function renamePeer(storage, id, name) {
  const peers = loadPeers(storage);
  const k = String(id);
  if (!peers[k]) return null;
  peers[k].name = name;
  writeJson(storage, PEERS_KEY, peers);
  return peers[k];
}

export function forgetPeer(storage, id) {
  const peers = loadPeers(storage);
  delete peers[String(id)];
  writeJson(storage, PEERS_KEY, peers);
}

/** 已知设备列表，按最后联系时间倒序 */
export function peerList(storage) {
  return Object.values(loadPeers(storage)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
