/* =========================
   グローバル設定とユーティリティ
   ========================= */

// Leaflet カラーピン（緑/赤）
const greenIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});
const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

// S/G マーカー（初期は非表示）
let startMarker = null;
let goalMarker  = null;

// S/Gに設定したとき、同じ地点がルートに居たら自動で除外する
const AUTO_REMOVE_ROUTE_ON_SET_SG = true;
// S/G を「経由地」ボタンでどう扱うか: 'move'（降格=移動） or 'copy'（複製）
const SG_TO_VIA_MODE = 'move';

// 位置の同一判定（重複検出用）
const sameLL = (a,b,eps=1e-7)=> Math.abs(a.lat-b.lat)<eps && Math.abs(a.lng-b.lng)<eps;

// S/G の状態（リスト表示やGoogleマップURL生成に使用）
let startPoint = null; // { lat, lng, label }
let goalPoint  = null; // { lat, lng, label }

/* ===== 時間帯フィルター制御（統一版） ===== */
let currentTwFilter = null; // null=全件, 文字列=その時間帯のみ

const isFilterOn = () => currentTwFilter !== null;
const matchFilter = (p) => !isFilterOn() || p.tw === currentTwFilter;

// フィルター中の操作を制御する関数
function guardFilter(actionName) {
  if (!isFilterOn()) return true; // フィルターOFF = 実行OK
  
  alert(`時間帯フィルター中は${actionName}できません。\nフィルターを解除してから実行してください。`);
  return false; // フィルターON = 実行NG
}

// ルート基点（地図の初期中心用）
const startEnd = { name:"大田区役所", lat:35.5611, lng:139.7161 };

// 疑似データ（デモ用の経由地）
const rand=(a,b)=>Math.random()*(b-a)+a;
const base={lat:35.5611,lng:139.7161};
const timeWindows=[null,"午前中","14-16","16-18","18-20","19-21"];
const TW_LABELS = timeWindows.filter(Boolean); // ["午前中","14-16","16-18","18-20","19-21"]
const randomTW=()=>Math.random()<0.25?timeWindows[1+Math.floor(Math.random()*(timeWindows.length-1))]:null;
const stores=Array.from({length:50},(_,i)=>({
  id:i+1,label:`コンビニ #${i+1}`,
  lat:base.lat+rand(-0.02,0.02),lng:base.lng+rand(-0.025,0.025),
  tw:randomTW()
}));

// 距離 & 簡易最適化
function haversine(a,b){
  const R=6371,toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng);
  const lat1=toRad(a.lat),lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function nearestNeighbor(points,start){
  const u=points.slice();let cur={lat:start.lat,lng:start.lng};const order=[];
  while(u.length){
    let k=0,bd=1e9;
    for(let i=0;i<u.length;i++){const d=haversine(cur,u[i]);if(d<bd){bd=d;k=i;}}
    const nx=u.splice(k,1)[0];order.push(nx);cur=nx;
  }
  return order;
}
function twoOpt(route,start){
  function total(seq){let d=0,cur=start;for(const p of seq){d+=haversine(cur,p);cur=p;}d+=haversine(cur,start);return d;}
  let best=route.slice(),bestD=total(best),n=best.length,improved=true;
  while(improved){
    improved=false;
    for(let i=0;i<n-1;i++){
      for(let k=i+1;k<n;k++){
        const cand=best.slice(0,i).concat(best.slice(i,k+1).reverse(),best.slice(k+1));
        const d=total(cand);
        if(d+1e-9<bestD){best=cand;bestD=d;improved=true;}
      }
    }
  }
  return best;
}
let route = twoOpt(nearestNeighbor(stores,startEnd), startEnd); // 経由地のみ保持

// ===== 入力正規化ユーティリティ =====
function normalizeAddressInput(input) {
  if (!input) return "";

  let s = input.normalize("NFKC");       // 全半角統一

  s = s.replace(/\s+/g, " ").trim();     // 空白圧縮 + トリム
  s = s.replace(/[‐\-–—―ー−]/g, "-");   // ハイフン類を統一
  s = s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)); // 全角数字→半角
  s = s.replace(/〒/g, "");              // 郵便記号を削除

  // 安全な約物を削除（町名でまず出ないやつ）
  s = s.replace(/[、。．，！？「」『』（）［］〈〉＜＞…・：;]/g, "");

  // 丁目の漢数字→算用数字（例: 三丁目 → 3丁目）
  s = s.replace(/([一二三四五六七八九十百千]+)丁目/g, (m, kanji) => {
    return jpNumToInt(kanji) + "丁目";
  });

  return s;
}

// 住所文字列 → アンカー要素だけ先に取りたい時用（辞書ヒットまではしない）
export async function anchorFromAddress(address){
  const { normalize } = await import("https://esm.sh/@geolonia/normalize-japanese-addresses");
  const nja = await normalize(address);
  const city = nja.city || nja.county || "";
  const ward = TOKYO_WARDS[city];                  // 例: { code:"13102", slug:"chuo", ... }
  const { town, chome } = townChomeFrom(nja.town); // 例: "銀座", 1
  const wardCode = ward?.code || "";
  const anchorKey = `${town}|${chome ?? "-"}`;     // 例: "銀座|1"
  const anchor = wardCode ? `${wardCode}|${anchorKey}` : "";  // 例: "13102|銀座|1"
  return { wardCode, anchorKey, anchor, nja };
}

/* ===== 時間帯フィルター切り替え ===== */
function setTwFilter(twLabel) {
	// フィルター中の操作を制御する関数（統一版）
function guardFilter(actionName) {
  if (!isFilterOn()) return true; // フィルターOFF = 実行OK
  
  alert(`時間帯フィルター中は${actionName}できません。\nフィルターを解除してから実行してください。`);
  return false; // フィルターON = 実行NG
}
  // 同じボタンをもう一度押したら解除（ON/OFFトグル）
  currentTwFilter = (currentTwFilter === twLabel) ? null : twLabel;

  // ボタンの見た目だけ同期（.is-active付与/除去）
  syncFilterButtons();

  // 反映：描画は“表示制御のみ”
  renderMarkers();
  renderList();
  applyHighlight(); // フィルターON中は中でno-op化
}

/* ===== 時間帯UI生成（統合版） ===== */
function createTimeWindowButtons(currentTW, onChange, context = 'list') {
  // contextで使い分け: 'popup' or 'list'
  const btnClass = context === 'popup' ? 'pin-btn tw' : 'tw-btn';
  
  // 1. HTMLを生成
  const btns = TW_LABELS.map(tw => {
    const active = currentTW === tw ? 'is-active' : '';
    return `<button class="${btnClass} ${active}" data-tw="${tw}">${tw}</button>`;
  });
  const unassigned = !currentTW ? 'is-active' : '';
  btns.push(`<button class="${btnClass} ${unassigned}" data-tw="">未割当</button>`);
  
  const html = btns.join('');
  
  // 2. イベントを結びつける関数
  const wire = (container) => {
    const selector = context === 'popup' ? '.pin-btn.tw' : '.tw-btn';
    container.querySelectorAll(selector).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tw = btn.getAttribute('data-tw') || null;
        
        // 見た目の更新（is-activeの付け替え）
        container.querySelectorAll(selector).forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        
        // 外部に通知
        onChange(tw);
      });
    });
  };
  
  return { html, wire };
}

/* =========================
   Leaflet 初期化
   ========================= */

const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([startEnd.lat,startEnd.lng],13);

// ベースレイヤ（Voyager→失敗時OSMにフォールバック）
function addBaseLayer(map) {
  const voyager = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 20, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' }
  );
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>' });
  voyager.on('tileerror', () => { if (!map.hasLayer(osm)) map.addLayer(osm); });
  voyager.addTo(map);
}
addBaseLayer(map);
L.control.zoom({position:'bottomright'}).addTo(map);
map.whenReady(()=>{ setTimeout(()=>map.invalidateSize(),100); });
window.addEventListener('resize',()=>{
  setTimeout(()=>map.invalidateSize(),100);
  // ★ 追加：開いているときだけ高さを再計算
  if (listPanel.classList.contains('open')) layoutListPanel();
});

/* =========================
   検索レイヤ & ポップアップUI
   ========================= */

const searchLayer = L.layerGroup().addTo(map);

// ポップアップHTML
function makePinPopupHTML(title='地点'){
  return `
    <div class="pin-popup">
      <div class="pin-title">${title}</div>
      <div class="pin-actions">
        <button class="pin-btn start">出発地</button>
        <button class="pin-btn via">経由地</button>
        <button class="pin-btn goal">目的地</button>
        <button class="pin-btn edit" title="編集">✏️</button>
        <button class="pin-btn delete" title="削除">🗑️</button>
      </div>
    </div>`;
}

// 出発地に設定
function setAsStart(lat, lng, label) {
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker([lat, lng], { icon: greenIcon }).addTo(map);

  // ボタン付きポップアップ + 先に wire
  startMarker.bindPopup(makePinPopupHTML("出発：" + label));
  wirePopup(startMarker, { kind: 'start', label });

  // S バッジ
  startMarker.bindTooltip("S", { permanent: true, direction: 'top', className: 'sg-tip-start' });

  startPoint = { lat, lng, label };
  renderList();
  map.setView([lat, lng], 15, { animate: true });
}

// 目的地に設定
function setAsGoal(lat, lng, label) {
  if (goalMarker) map.removeLayer(goalMarker);
  goalMarker = L.marker([lat, lng], { icon: redIcon }).addTo(map);

  // ボタン付きポップアップ + 先に wire
  goalMarker.bindPopup(makePinPopupHTML("到着：" + label));
  wirePopup(goalMarker, { kind: 'goal', label });

  // G バッジ
  goalMarker.bindTooltip("G", { permanent: true, direction: 'top', className: 'sg-tip-goal' });

  goalPoint = { lat, lng, label };
  renderList();
  map.setView([lat, lng], 15, { animate: true });
}

// ポップアップのボタンに処理を結びつける
function wirePopup(marker, info) {
  marker.on('popupopen', (e) => {
    const node = e.popup.getElement();
    if (!node) return;
    const q = (sel) => node.querySelector(sel);
    const getLL = () => marker.getLatLng();
    const label = info?.label || '地点';
    
        q('.pin-btn.start')?.addEventListener('click', () => {
      const { lat, lng } = getLL();
      // ルート上の点をSに昇格させたら、重複を避けるため除外
      if (AUTO_REMOVE_ROUTE_ON_SET_SG && info?.kind==='route') {
        route = route.filter(p => p.id !== info.id);
        try { map.removeLayer(marker); } catch(_){}
      }
      setAsStart(lat, lng, label);
      renderMarkers(); renderList(); // 反映
      marker.closePopup();
    });

    q('.pin-btn.via')?.addEventListener('click', () => {
  const { lat, lng } = getLL();
  const label = info?.label || '経由地';

  // S/G から経由地へ：二重にならないように挙動を制御
  if (info?.kind === 'start') {
    if (SG_TO_VIA_MODE === 'move') {
      // S を外してから経由地へ移す
      if (startMarker) { try { map.removeLayer(startMarker); } catch(_){} startMarker = null; }
      startPoint = null;
      renderList(); // 下部パネル反映
    }
    // 'copy' の場合はSを残したまま経由地を追加
    addVia(lat, lng, label);
    marker.closePopup();
    return;
  }

  if (info?.kind === 'goal') {
    if (SG_TO_VIA_MODE === 'move') {
      // G を外してから経由地へ移す
      if (goalMarker) { try { map.removeLayer(goalMarker); } catch(_){} goalMarker = null; }
      goalPoint = null;
      renderList();
    }
    addVia(lat, lng, label);
    marker.closePopup();
    return;
  }
// ルートピン/検索ピンは従来通り末尾に追加（重複は addVia 内で無視）
  addVia(lat, lng, label);
  marker.closePopup();
});

    q('.pin-btn.goal')?.addEventListener('click', () => {
      const { lat, lng } = getLL();
      if (AUTO_REMOVE_ROUTE_ON_SET_SG && info?.kind==='route') {
        route = route.filter(p => p.id !== info.id);
        try { map.removeLayer(marker); } catch(_){}
      }
      setAsGoal(lat, lng, label);
      renderMarkers(); renderList();
      marker.closePopup();
    });
    
    q('.pin-btn.edit')?.addEventListener('click', () => {
      alert('編集機能は準備中です');
      // TODO: フェーズ3で実装
    });

    q('.pin-btn.delete')?.addEventListener('click', () => {
      deletePoint(info.kind, info);
      marker.closePopup();
    });

        // ▼▼ 時間帯（統合版・経由地のみ） ▼▼
if (info?.kind === 'route') {
  const host = node.querySelector('.pin-popup') || node;
  const wrap = document.createElement('div');
  wrap.style.marginTop = '.75rem';
  
  // 統合関数を使う（popup用）
  const twUI = createTimeWindowButtons(info.tw, (tw) => {
    const p = route.find(x => x.id === info.id);
    if (p) p.tw = tw || null;
    renderMarkers();
    renderList();
    marker.closePopup();
  }, 'popup');
  
  // Gマップボタンを先頭に追加
  const gmapsBtn = `<button class="pin-btn tw gmaps-inline" data-label="${info.label}">Gマップ</button>`;
  wrap.innerHTML = `<div class="pin-actions" style="justify-content:flex-start;">${gmapsBtn}${twUI.html}</div>`;
  host.appendChild(wrap);
  
  // Gマップボタンのイベント
  wrap.querySelector('.gmaps-inline')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const label = e.target.getAttribute('data-label');
    openPointInGoogleMaps(label);
  });
  
  // 時間帯ボタンのイベント
  twUI.wire(wrap);
}
  });
}



function addVia(lat, lng, label) {
  // 既に同じ座標があるならスキップ（重複防止）
  const dup = route.find(p => sameLL(p, {lat, lng}));
  if (dup) return;

  const nextId = Math.max(0, ...route.map(p => p.id || 0)) + 1;
  route.push({ id: nextId, label: label || '経由地', lat, lng, tw: null });
  

  renderMarkers(); renderList(); applyHighlight();
}

// 統合版：あらゆる地点を削除する
function deletePoint(type, data) {
  switch(type) {
    case 'route':
      // 経由地を削除
      route = route.filter(p => p.id !== data.id);
      renderMarkers(); renderList(); applyHighlight();
      break;
      
    case 'search':
      // 検索ピンを削除
      try { searchLayer.clearLayers(); } catch(_){}
      break;
      
    case 'start':
      // 出発地を削除
      if (startMarker) {
        try { map.removeLayer(startMarker); } catch(_){}
        startMarker = null;
        startPoint = null;
        renderList();
      }
      break;
      
    case 'goal':
      // 目的地を削除
      if (goalMarker) {
        try { map.removeLayer(goalMarker); } catch(_){}
        goalMarker = null;
        goalPoint = null;
        renderList();
      }
      break;
  }
}

// ルート内のロック（固定）トグル
function toggleLock(id, force){
  const p = route.find(x => x.id === id);
  if(!p) return;
  p.locked = (typeof force==='boolean') ? force : !p.locked;
  renderMarkers(); renderList();
}

function optimizeRoute(){
  // ロックを尊重して非破壊的に最適化
  const lockedSlots = [];  // [{idx, p}]
  const unlocked = [];     // [p]

  route.forEach((p, idx) => {
    if (p.locked) lockedSlots.push({ idx, p });
    else unlocked.push(p);
  });

  if (unlocked.length <= 1) {
    applyHighlight();
    return; // 最適化不要
  }

  // アンカー（起点）
  const startAnchor = startPoint || unlocked[0];

  // アンカーを起点に unlocked をNN→2-opt
  let optimizedUnlocked = twoOpt(nearestNeighbor(unlocked, startAnchor), startAnchor);

  // ロック位置を維持したままマージ
  const merged = new Array(route.length);
  lockedSlots.forEach(({idx,p}) => merged[idx] = p);
  let up = 0; // unlocked pointer
  for (let i=0; i<merged.length; i++){
    if (!merged[i]) merged[i] = optimizedUnlocked[up++];
  }

  route = merged;
  renderMarkers(); renderList(); applyHighlight();
}


/* =========================
   ルート上のマーカー描画
   ========================= */

let markers = [];
function renderMarkers(){
  // 既存ルートピンを消す
  markers.forEach(m=>{ try{ map.removeLayer(m); }catch(_){} });
  markers = [];

  const bounds = L.latLngBounds([[startEnd.lat,startEnd.lng]]);

  // 経由地マーカーを再描画
  route.forEach((p,i)=>{
     if (!matchFilter(p)) return; // ← 追加：フィルター非対象は描かない
	const title = `${i+1}. ${p.label}${p.tw?`（⏰${p.tw}）`:""}`;
    const m = L.marker([p.lat,p.lng]).addTo(map)
      .bindPopup(makePinPopupHTML(title));
    m.bindTooltip(String(i+1), { permanent: true, direction: 'top', className: 'idx-tip', offset: [-10, -4] });

    wirePopup(m, { kind: 'route', label: p.label, id: p.id, index: i, tw: p.tw });

    markers.push(m);
    bounds.extend([p.lat,p.lng]);
  });

  map.fitBounds(bounds.pad(0.1));
  applyHighlight();
}
// すべてのピン（通常・検索・S/G）とリストを削除
function clearAllPins() {
  // ルートの通常ピン
  markers.forEach(m => { try { map.removeLayer(m); } catch(_){} });
  markers = [];
  // ルート配列とリストUI
  route = [];
  if (listEl) listEl.innerHTML = "";
  // 検索ピン
  try { searchLayer.clearLayers(); } catch(_) {}
  // S/G
  if (startMarker) { try { map.removeLayer(startMarker); } catch(_) {} startMarker = null; }
  if (goalMarker)  { try { map.removeLayer(goalMarker); }  catch(_) {} goalMarker  = null; }
  startPoint = null;
  goalPoint  = null;
  // パック状態リセット
  packIndex = 0;
  // 初期ビューへ
  map.setView([startEnd.lat, startEnd.lng], 12);
}

/* =========================
   下部パネル / リスト描画
   ========================= */

const listPanel=document.querySelector('.list-panel');
const listHeader=document.querySelector('.list-header');
const listEl=document.getElementById('poi-list');
const headerEl=document.querySelector('.header');
const getPanelTopLimit=()=>headerEl.getBoundingClientRect().bottom+8;

function layoutListPanel() {
  // ヘッダー直下まで引き上げる現在の仕様はそのまま
  const top = getPanelTopLimit(); // ヘッダー下端 + 8px
  const panelH = Math.max(200, window.innerHeight - top - 8); // パネルの実高さ

  // パネル自身の高さを固定（中をスクロールさせる前提）
  listPanel.style.height = panelH + 'px';

  // 既存の「開くときの translateY」計算と同じ式を使って位置だけ合わせる
  const ph = panelH;
  listPanel.style.transform = `translateY(${top - window.innerHeight + ph}px)`;

  // 中身(#poi-list)をスクロール領域にする
  const headerH = listHeader.getBoundingClientRect().height || 56;
  const safe = 24; // 下余白（必要なら増やしてOK）
  listEl.style.overflowY = 'auto';
  listEl.style.webkitOverflowScrolling = 'touch';
  listEl.style.maxHeight = (panelH - headerH - safe) + 'px';
  listEl.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + 24px)';
}

listHeader.addEventListener('click',()=>{
  listPanel.style.transition='transform .3s ease-in-out';
  if(listPanel.classList.contains('open')){
    listPanel.classList.remove('open');
    listPanel.style.transform='translateY(calc(100% - 4.5rem))';
  }else{
    listPanel.classList.add('open');

    // ★ 追加：高さとスクロール領域をセット
    layoutListPanel();

    const top=getPanelTopLimit(); const ph=listPanel.getBoundingClientRect().height;
    listPanel.style.transform=`translateY(${top - window.innerHeight + ph}px)`;
    setTimeout(()=>map.invalidateSize(),80);
  }
});

// ▼ リスト自動スクロール（ドラッグ中に上下へ送る）
let __autoScrollBound = false;
function bindAutoScrollForList(){
  if (__autoScrollBound) return;
  __autoScrollBound = true;

  const EDGE = 40;        // 上下「感知ゾーン」の幅(px)
  const MAX_SPEED = 22;   // 最大スクロール速度(px/イベント)
  const list = listEl;

  // リスト全体で dragover を拾い、上下端に近づいたらスクロール
  list.addEventListener('dragover', (e) => {
    e.preventDefault(); // ドロップ可能に
    const rect = list.getBoundingClientRect();
    const y = e.clientY;

    let dy = 0;
    if (y < rect.top + EDGE) {
      // 上スクロール（端に近いほど速く）
      dy = -Math.min(MAX_SPEED, (rect.top + EDGE - y) * 0.5);
    } else if (y > rect.bottom - EDGE) {
      // 下スクロール
      dy = Math.min(MAX_SPEED, (y - (rect.bottom - EDGE)) * 0.5);
    }

    if (dy !== 0) {
      list.scrollTop += dy;
    }
  }, { passive:false });
}


function renderList(){
  listEl.innerHTML="";

  // --- S（固定・非ドラッグ） ---
  if (startPoint) {
    const s = document.createElement('div');
    s.className = 'poi-card';
    s.innerHTML = `
      <div class="badge" style="background:#22c55e;">S</div>
      <div class="poi-content">
        <div class="poi-name">出発：${startPoint.label}</div>
        <div class="poi-meta">（${startPoint.lat.toFixed(5)}, ${startPoint.lng.toFixed(5)}）</div>
      </div>`;
    s.onclick = () => map.setView([startPoint.lat, startPoint.lng], 16, {animate:true});
    listEl.appendChild(s);
  }

// --- 経由地（ドラッグ可） ---
  route.forEach((p,i)=>{
    if (!matchFilter(p)) return; // ← 追加：非対象カードは作らない
	const div=document.createElement('div');
    div.className='poi-card'; div.setAttribute('draggable','true'); div.dataset.id=p.id;
    div.innerHTML = `
  <div class="badge" id="badge-${i}">${i+1}</div>
  <button class="lock-btn" aria-label="固定/解除" title="固定/解除">🔓</button>

  <div class="poi-content">
    <div class="poi-name">
      ${p.label}${p.tw ? `<span class="tw-badge">⏰ ${p.tw}</span>` : ""}
    </div>
  </div>

  <button class="del-btn" aria-label="削除" title="削除">🗑️</button>
`;
// ▼▼ 時間帯割当（リスト版・統合版）▼▼
const content = div.querySelector('.poi-content');
if (content) {
  const wrap = document.createElement('div');
  
  // 統合関数を使う
  const twUI = createTimeWindowButtons(p.tw, (tw) => {
    p.tw = tw || null;
    renderMarkers();
    renderList();
  });
  
  // Gマップボタン + 時間帯ボタン
  wrap.innerHTML = `
  <div class="tw-strip">
    <button class="tw-btn gmaps-btn">Gマップ</button>
    ${twUI.html}
  </div>`;
  content.appendChild(wrap);
  
  // Gマップボタンのイベント
  wrap.querySelector('.gmaps-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPointInGoogleMaps(p.label);
  });
  
  // 時間帯ボタンのイベント
  twUI.wire(wrap);
}
// ▲▲ ここまで（リスト版）▲▲


    // ロック表示初期化
const lockBtn = div.querySelector('.lock-btn');
const setLockUI = ()=>{
  lockBtn.textContent = p.locked ? '🔒' : '🔓';
  div.style.opacity = p.locked ? '.8' : '1';
  div.style.cursor  = p.locked ? 'default' : 'grab';
  div.setAttribute('draggable', p.locked ? 'false' : 'true');
};
setLockUI();
lockBtn.onclick = (e)=>{ e.stopPropagation(); toggleLock(p.id); };

// ▼ 右端の削除ボタン
const delBtn = div.querySelector('.del-btn');
delBtn.onclick = (e) => {
  e.stopPropagation();
  deletePoint('route', { id: p.id });
};


// ロック中はドラッグ系を無効化
div.addEventListener('dragstart', e=>{ if(p.locked){ e.preventDefault(); return; } e.dataTransfer.setData('text/plain',p.id.toString()); setTimeout(()=>div.style.opacity='.5',0); });
div.addEventListener('dragover', e=>{ if(p.locked){ return; } e.preventDefault(); div.classList.add('drag-over'); });


    // カードクリックで地図へジャンプ
    div.onclick=()=>{ map.setView([p.lat,p.lng],16,{animate:true});
      listPanel.classList.remove('open'); listPanel.style.transform='translateY(calc(100% - 4.5rem))';
      setTimeout(()=>map.invalidateSize(),80); };

    // --- フィルターON中は DnD 停止、OFFの時だけ DnD を有効化 ---
const DND_ENABLED = !isFilterOn();

if (!DND_ENABLED) {
  // DnDを完全停止（見た目も掴めないように）
  div.setAttribute('draggable','false');
  div.style.cursor = 'default';
} else {
  // ロック中は無効、それ以外は従来どおり
  div.addEventListener('dragstart', e => {
    if (p.locked) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', p.id.toString());
    setTimeout(()=> div.style.opacity = '.5', 0);
  });
  div.addEventListener('dragend', () => div.style.opacity='1');
  div.addEventListener('dragover', e => {
    if (p.locked) return;
    e.preventDefault();
    div.classList.add('drag-over');
  });
  div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
  div.addEventListener('drop', e => {
    e.preventDefault();
    div.classList.remove('drag-over');
    const draggedId = parseInt(e.dataTransfer.getData('text/plain'),10);
    if (draggedId === p.id) return;
    const from = route.findIndex(x => x.id === draggedId);
    const to   = route.findIndex(x => x.id === p.id);
    const item = route.splice(from,1)[0];
    route.splice(to,0,item);
    renderMarkers(); renderList();
  });
}

    listEl.appendChild(div);
  });

  // --- G（固定・非ドラッグ） ---
  if (goalPoint) {
    const g = document.createElement('div');
    g.className = 'poi-card';
    g.innerHTML = `
      <div class="badge" style="background:#ef4444;">G</div>
      <div class="poi-content">
        <div class="poi-name">目的地：${goalPoint.label}</div>
        <div class="poi-meta">（${goalPoint.lat.toFixed(5)}, ${goalPoint.lng.toFixed(5)}）</div>
      </div>`;
    g.onclick = () => map.setView([goalPoint.lat, goalPoint.lng], 16, {animate:true});
    listEl.appendChild(g);
  }

    applyHighlight();
  if (listPanel.classList.contains('open')) layoutListPanel();

  // ★ 追加：自動スクロールを一度だけバインド
  bindAutoScrollForList();
}

/* =========================
   パック強調 / Googleマップ連携
   ========================= */

let packIndex=0; const packSize=10;

function applyHighlight(){
 if (isFilterOn()) return; // ← 追加：フィルター中はパック強調を無効化（安全最小） // 見た目の強調
  markers.forEach(m => { const el = m.getElement?.(); if (el) el.classList.remove('active'); });
  const begin = packIndex * packSize;
  const end   = Math.min(begin + packSize, route.length) - 1;

  const bnds = L.latLngBounds([]);
  if (startPoint) bnds.extend([startPoint.lat, startPoint.lng]);
  if (goalPoint)  bnds.extend([goalPoint.lat,  goalPoint.lng]);

  if (begin <= end) {
    for (let i = begin; i <= end; i++) {
      bnds.extend([route[i].lat, route[i].lng]);
      const el = markers[i]?.getElement?.();
      if (el) el.classList.add('active');
    }
  }
  if (bnds.isValid()) map.fitBounds(bnds.pad(0.2));
}

// ラベル文字列をそのまま投げる（空白などだけ整形）
// 正規化したい場合は normalizeAddressInput を呼ぶ
function pointToMapsParam(pt, { normalize=true } = {}) {
  if (!pt) return '';
  const raw = ((pt.label || '') + '').replace(/\s+/g, ' ').trim();
  return normalize ? (normalizeAddressInput?.(raw) ?? raw) : raw;
}

// 単一アドレスをそのまま検索タブで開く（必要ならボタン等から呼べる）
function openInGoogleMapsAddress(addr, { normalize=true } = {}) {
  const q = normalize ? normalizeAddressInput(addr) : (addr || '');
  if (!q) return;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  window.open(url, "_blank");
}

// 統合版：地点をGoogleマップで開く
function openPointInGoogleMaps(label) {
  openInGoogleMapsAddress(label, { normalize: false });
}

function openPack(){
  const beginIdx = packIndex * packSize;
  const endIdx   = Math.min(beginIdx + packSize, route.length) - 1;

  const toParam = (pt) => pointToMapsParam(pt, { normalize: true }); // ←常にテキスト

  const pts = (beginIdx <= endIdx) ? route.slice(beginIdx, endIdx+1) : [];

  let origin;
  if (startPoint) origin = toParam(startPoint);
  else if (packIndex===0 && pts[0]) origin = toParam(pts[0]);
  else if (packIndex>0 && route[beginIdx-1]) origin = toParam(route[beginIdx-1]);
  else origin = toParam(startEnd);

  let destination;
  if (goalPoint) destination = toParam(goalPoint);
  else if (pts.length) destination = toParam(pts[pts.length-1]);
  else destination = origin;

  const waypoints = pts.length > 1 ? pts.slice(0,-1).map(toParam).join('|') : '';

  const url = `https://www.google.com/maps/dir/?api=1`
    + `&origin=${encodeURIComponent(origin)}`
    + `&destination=${encodeURIComponent(destination)}`
    + (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '')
    + `&travelmode=driving`;

  window.open(url, "_blank");
}

/* =========================
   一括/コピペ パネル
   ========================= */

const bulkOpen  = document.getElementById('bulkOpen');
const bulkPanel = document.getElementById('bulkPanel');
const bulkInput = document.getElementById('bulkInput');
const extractBtn= document.getElementById('extractBtn');
const addBtn    = document.getElementById('addBtn');
const bulkClose = document.getElementById('bulkClose');

bulkOpen?.addEventListener('click', () => {
  bulkPanel.style.display = 'block';
  setTimeout(()=>map.invalidateSize(), 80);
});
bulkClose?.addEventListener('click', () => {
  bulkPanel.style.display = 'none';
  setTimeout(()=>map.invalidateSize(), 80);
});

// ▼ 「C」入力クリアボタンを閉じるボタンの右に動的追加
(function initBulkClear(){
  const closeBtn = bulkClose;
  if (!closeBtn || document.getElementById('bulkClear')) return;

  const cBtn = document.createElement('button');
  cBtn.id = 'bulkClear';
  cBtn.type = 'button';
  cBtn.textContent = 'C';
  cBtn.title = 'テキスト入力を全て削除';
  cBtn.className = 'pill'; // 既存の見た目に合わせる（#bulkPanel .pill）
  cBtn.style.marginLeft = '.25rem';

  closeBtn.insertAdjacentElement('afterend', cBtn);

  cBtn.addEventListener('click', ()=>{
    if (!bulkInput) return;
    const ok = confirm('テキスト入力を全て削除しますか？');
    if (ok) bulkInput.value = '';
  });
})();

// ▼ 「住所だけ抽出」ボタン処理（1件=1〜2行＋区切り線）
extractBtn?.addEventListener('click', () => {
  const src = bulkInput.value || '';
  const ents = extractEntries(src);

  // 区切り線は短めのダッシュ。再抽出時は無視される（DASH_ONLY で除外）
  const SEP = '――――';

  const blocks = ents.map(e => {
    const lines = e.addr2 ? [e.addr1, e.addr2] : [e.addr1];
    return lines.concat(SEP).join('\n'); // 1〜2行＋線
  });

  bulkInput.value = blocks.join('\n'); // ブロック同士は改行1つ（=見やすく詰める）
});

// ▼ 一括「取り込み」：住所だけをルートに追加（先に即時表示→あとで順次ジオコーディング）
addBtn?.addEventListener('click', async () => {
  const src = bulkInput.value || '';
  const ents = extractEntries(src);      // ← さっき入れた住所抽出（住所1/住所2）
  if (!ents.length) { alert('住所が見つかりません'); return; }

  const nextIdBase = Math.max(0, ...route.map(x => x.id || 0)) + 1;

  // 1) まずは仮座標で即時追加（UIを素早く更新）
  const pending = ents.map((e, i) => {
    const label = e.addr2 ? `${e.addr1} ${e.addr2}` : e.addr1;  // ラベルは連結でOK
    return { id: nextIdBase + i, label, lat: startEnd.lat, lng: startEnd.lng, tw: null };
  });
  route.push(...pending);
  renderMarkers(); renderList();
  listPanel.classList.add('open');
  setTimeout(()=>map.invalidateSize(), 80);

  // 2) 可能なら順次ジオコーディング（東京都23区の辞書 + nja）
  for (const p of pending) {
    try {
      const r = await geocodeTokyo23(p.label);   // 既存の関数をそのまま利用
      if (r && r.ok) {
        p.lat = r.lat; p.lng = r.lng;
        // p.label はユーザー入力重視でそのまま。辞書の r.label を足したいならここで連結可
        renderMarkers(); // 逐次で位置を反映（重くなるなら最後に1回だけでもOK）
      }
    } catch (_) { /* 失敗時は無視（仮座標のまま）*/ }
  }
  renderList(); // 最後に整える
});


// 住所抽出（厳しめ本体 + ゆるめ建物）
function normalizeLoosely(s){
  if(!s) return s;
  return s.normalize('NFKC')
          .replace(/[ー−―－‐]/g,'-')
          .replace(/[、，]/g,' ')
          .replace(/^[\.\。\,、]+/, '')
          .replace(/\s+/g,' ')
          .trim();
}

// 住所コア（厳しめ）：都道府県/東京23区/政令市 + 町丁目 + 番地系
const PREF = '(?:北海道|(?:京|香|愛)?都|(?:..)?県)'; // ゆるいけど十分
const TOKYO_23 = '(?:東京都(?:特別)?区|東京都)'; // 実質「東京都」
const CITY = '(?:市|区|郡|町|村)';
const TOWN = '.+?'; // 後続で丁目/番地で締める
const CHOME = '(?:[一二三四五六七八九十〇零\\d]+)丁目';
const BAN_GO = '(?:\\d{1,3}(?:-\\d{1,3}){0,3})(?:号)?'; // 2-5-10, 12-4-3 など
const CORE_RE = new RegExp(
  `^(?:${TOKYO_23}|${PREF}|(?:東京都)?(?:[^\\s]+${CITY}))${TOWN}(?:${CHOME})?\\s*${BAN_GO}\\b`
);

// 建物キーワード（ゆるめ）
const BLDG_WORDS = [
  'ビル','マンション','アパート','ハイツ','コーポ','メゾン','タワー','レジデンス','テラス','ヴィラ','ヒル','サイド',
  'ヒルズ','ガーデン','パーク','スクエア','シティ','コート','プラザ','ステージ','カレッジ','ハウス'
];
const ROOM_TOKENS = [
  '\\d{1,3}号室','\\d{1,3}[A-Za-z]?-?\\d{0,3}号','\\d{1,2}F','\\d{1,2}階','[A-Z]-?\\d{3}'
];
const NAME_NOISE = /(様|御中|宛|部|課|係|受付|レセプション)/;

const BLDG_RE = new RegExp(
  `(?:${BLDG_WORDS.map(w=>w.replace(/[-/\\^$*+?.()|[\\]{}]/g,'\\$&')).join('|')})|(?:${ROOM_TOKENS.join('|')})`
);

// 「—」だけ・飾り線
const DASH_ONLY = /^[—\-－─━_]+$/;

// 1件を { addr1, addr2 } で返す
function extractEntries(text){
  const rawLines = (text||'').split(/\r?\n/).map(normalizeLoosely).filter(Boolean);
  const lines = rawLines.filter(l => !DASH_ONLY.test(l));

  const entries = [];
  for (let i=0; i<lines.length; i++){
    const line = lines[i];

    // 1) 住所コア
    if (!CORE_RE.test(line)) continue;

    const entry = { addr1: line, addr2: '' };

    // 2) 直後の1〜2行を見て、建物/部屋なら採用
    for (let k=1; k<=2 && i+k < lines.length; k++){
      const nxt = lines[i+k];

      // 氏名/会社 宛の可能性はスキップ（ただしフロア/号室を含むなら拾う）
      if (NAME_NOISE.test(nxt) && !BLDG_RE.test(nxt)) continue;

      // 都道府県や市区町村をもう一度含む場合は“次の住所”とみなして打ち切り
      if (CORE_RE.test(nxt)) break;

      if (BLDG_RE.test(nxt)) {
        entry.addr2 = nxt.replace(/\s+/g,'');
        i += k; // 消費（1行進める）
        break;
      }
      // 建物名がダッシュ「—」などは無視して続行
      if (DASH_ONLY.test(nxt)) { i += k; break; }
    }

    entries.push(entry);
  }
  return entries;
}
/* =========================
   検索（@geolonia/nja + 区別辞書）
   ========================= */

const searchBtn = document.getElementById('searchBtn');
const searchInput = document.getElementById('searchInput');

const TOKYO_WARDS = {
  "千代田区": { code:"13101", slug:"chiyoda",  label:"千代田区" },
  "中央区":   { code:"13102", slug:"chuo",     label:"中央区" },
  "港区":     { code:"13103", slug:"minato",   label:"港区" },
  "新宿区":   { code:"13104", slug:"shinjuku", label:"新宿区" },
  "文京区":   { code:"13105", slug:"bunkyo",   label:"文京区" },
  "台東区":   { code:"13106", slug:"taito",    label:"台東区" },
  "墨田区":   { code:"13107", slug:"sumida",   label:"墨田区" },
  "江東区":   { code:"13108", slug:"koto",     label:"江東区" },
  "品川区":   { code:"13109", slug:"shinagawa",label:"品川区" },
  "目黒区":   { code:"13110", slug:"meguro",   label:"目黒区" },
  "大田区":   { code:"13111", slug:"ota",      label:"大田区" },
  "世田谷区": { code:"13112", slug:"setagaya", label:"世田谷区" },
  "渋谷区":   { code:"13113", slug:"shibuya",  label:"渋谷区" },
  "中野区":   { code:"13114", slug:"nakano",   label:"中野区" },
  "杉並区":   { code:"13115", slug:"suginami", label:"杉並区" },
  "豊島区":   { code:"13116", slug:"toshima",  label:"豊島区" },
  "北区":     { code:"13117", slug:"kita",     label:"北区" },
  "荒川区":   { code:"13118", slug:"arakawa",  label:"荒川区" },
  "板橋区":   { code:"13119", slug:"itabashi", label:"板橋区" },
  "練馬区":   { code:"13120", slug:"nerima",   label:"練馬区" },
  "足立区":   { code:"13121", slug:"adachi",   label:"足立区" },
  "葛飾区":   { code:"13122", slug:"katsushika",label:"葛飾区" },
  "江戸川区": { code:"13123", slug:"edogawa", label:"江戸川区" }
};
window.TOKYO_WARDS = TOKYO_WARDS;
const INDEX_CACHE = {}; // ward.code → 辞書JSON

async function loadWardIndex(pref, city){
  if (pref !== "東京都") throw new Error("東京都のみ対応の最小版です");
  const ward = TOKYO_WARDS[city];
  if (!ward) throw new Error(`未対応の区です: ${city}`);
  if (INDEX_CACHE[ward.code]) return INDEX_CACHE[ward.code];

  const url = `indexes/13_tokyo/${ward.code}_${ward.slug}.min.json`;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`辞書ファイルが見つかりません: ${url}`);
  const json = await res.json();
  INDEX_CACHE[ward.code] = json;
  return json;
}
// 町/丁目抽出（漢数字→算用）
function jpNumToInt(s){
  if(!s) return null;
  if(/^\d+$/.test(s)) return parseInt(s,10);
  const tbl = {零:0,〇:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  let n = 0, lastTen=false;
  for(const c of s){
    if(c==='十'){ n=(n||1)*10; lastTen=true; }
    else { n += (tbl[c]??0); lastTen=false; }
  }
  return n || (lastTen?10:null);
}
function townChomeFrom(townName){
  const m = (townName||"").match(/(.+?)([一二三四五六七八九十〇零\d]+)丁目$/);
  if (m) return { town:m[1], chome: jpNumToInt(m[2]) };
  return { town: townName || "", chome: null };
}

// @geolonia/normalize-japanese-addresses で代表点に寄せる
async function geocodeTokyo23(address){
  const { normalize } = await import("https://esm.sh/@geolonia/normalize-japanese-addresses");
  const nja = await normalize(address);
  const pref = nja.pref || "";
  const city = nja.city || nja.county || "";

  const dict = await loadWardIndex(pref, city);
  const ward = TOKYO_WARDS[city]; // ← 追加：後続で ward.code を使うため

  const { town, chome } = townChomeFrom(nja.town);
  const data = dict.data || {};
  const hit = data[`${town}|${chome ?? "-"}`] || data[`${town}|-|`] || data[`__CITY__|-|-`];
  if (!hit) return { ok:false, reason:"辞書に該当なし" };

  const wardCode = ward?.code || "";
   const anchorKey = `${town}|${chome ?? "-"}`;
   return {
     ok: true,
     lat: hit.lat, lng: hit.lng, level: hit.level,
     label: (nja.town||"") + (chome ? `${chome}丁目` : ""),
     anchorKey,                      // 例: "銀座|1"
     wardCode,                       // 例: "13102"
     anchor: `${wardCode}|${anchorKey}` // 例: "13102|銀座|1"
   };
}

async function geocodeAndClassify(address) {
  try {
    const result = await geocodeTokyo23(address);
    
    if (!result.ok) {
      return { 
        status: 'FAILED', 
        label: address, 
        lat: null, 
        lng: null 
      };
    }
    
    // ラベルは常に元の入力住所を使う（番地情報を保持）
    const label = address;
    
    if (result.level === 'chome') {
      return { status: 'SUCCESS', ...result, label };
    }
    
    // 区まで or その他
    return { status: 'PARTIAL', ...result, label };
    
  } catch (e) {
    console.error('geocodeAndClassify error:', e);
    return { 
      status: 'FAILED', 
      label: address, 
      lat: null, 
      lng: null 
    };
  }
}

// ステータスに応じたバッジを返す
function getStatusBadge(status) {
  const badges = {
    'SUCCESS': '<span class="status-badge status-success">✓</span>',
    'PARTIAL': '<span class="status-badge status-partial">⚠</span>',
    'FAILED': '<span class="status-badge status-failed">✗</span>'
  };
  return badges[status] || '';
}

// 検索結果ピン（ポップアップ含む・ステータス対応）
function setSearchPin(lat, lng, label, status = 'SUCCESS') {
  searchLayer.clearLayers();
  
  // ステータスバッジ付きタイトル
  const badge = getStatusBadge(status);
  const title = `${label || "検索地点"} ${badge}`;
  
  const m = L.marker([lat, lng]).addTo(searchLayer)
    .bindPopup(makePinPopupHTML(title));

  // 先に wirePopup を仕込んでから
  wirePopup(m, { kind: 'search', label: label || "検索地点", status });

  // その後に openPopup
  m.openPopup();

  map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true });
  return m;
}

// 検索バーに × を挿入（固定位置・最小実装）
(function initSearchClear(){
  const bar   = document.querySelector('.search-bar');
  const input = document.getElementById('searchInput');
  if (!bar || !input) return;

  let clearBtn = bar.querySelector('.search-clear');
  if (!clearBtn) {
    clearBtn = document.createElement('button');
    clearBtn.className = 'search-clear';
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label','クリア');
    clearBtn.textContent = '×';
    bar.appendChild(clearBtn);
  }

  // ✕ボタンの位置は固定（70px）
  function placeClear(){
    clearBtn.style.right = '70px';
  }

  const toggle = () => {
    const v = (input.value || '').trim();
    clearBtn.style.display = v ? 'inline-flex' : 'none';
    placeClear();
  };

  input.addEventListener('input', toggle);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });

  window.addEventListener('resize', placeClear);
  setTimeout(placeClear, 0);
  toggle();
})();

// 検索ボタン/Enter（判定ロジック統合版）
async function onSearch() {
  const raw = (searchInput.value || '').trim();
  if (!raw) return;

  // 正規化を適用
  const q = normalizeAddressInput(raw);
  searchInput.value = q;

  try {
    // 共通判定関数を使う
    const result = await geocodeAndClassify(q);
    
    if (result.status === 'FAILED') {
      alert('座標を取得できませんでした。\n住所を確認するか、後でGoogleマップで開いてください。');
      // TODO: フェーズ3で「リストに追加」選択肢を提供
      return;
    }
    
    // ピンを立てる（ステータス付き）
    setSearchPin(result.lat, result.lng, result.label, result.status);
    
  } catch (e) {
    console.error(e);
    alert(e.message || "検索に失敗しました");
  }
}
searchBtn?.addEventListener("click", onSearch);
searchInput?.addEventListener("keydown", e => { if(e.key==="Enter") onSearch(); });

// 最適化ボタンの結線（統一版）
document.getElementById('optimizeBtn')?.addEventListener('click', () => {
  if (!guardFilter('最適化')) return;
  optimizeRoute();
});
/* =========================
   ヘッダーボタン連携
   ========================= */

// パック操作ボタン（統一版）
document.getElementById('openPack').onclick = () => {
  if (!guardFilter('Googleマップで開く')) return;
  openPack();
};

document.getElementById('nextPack').onclick = () => {
  if (!guardFilter('次の10件')) return;
  packIndex++;
  if (packIndex * packSize >= route.length) packIndex = 0;
  applyHighlight();
};

document.getElementById('prevPack').onclick = () => {
  if (!guardFilter('前の10件')) return;
  packIndex--;
  if (packIndex < 0) packIndex = Math.floor((route.length - 1) / packSize);
  applyHighlight();
};

const clearAllBtn = document.getElementById('clearAll');
if (clearAllBtn) {
  clearAllBtn.onclick = () => {
    const ok = confirm("本当に全てのピンを削除しますか？\n（S/Gと検索ピン、リストも消えます）");
    if (ok) clearAllPins();
  };
}

/* =========================
   初期描画
   ========================= */

renderMarkers();
renderList();
applyHighlight();

/* ===== 時間帯ボタン結線（index.htmlに既に並んでいる5つ） ===== */
// timeWindows: [null,"午前中","14-16","16-18","18-20","19-21"] が既存定義1
function syncFilterButtons() {
  const btns = Array.from(document.querySelectorAll('.btn-container .header-item'));
  const targets = new Set(timeWindows.filter(Boolean)); // 5つのラベル集合

  btns.forEach(el => {
    const label = (el.textContent || '').trim();
    if (!targets.has(label)) return; // 他のボタンは無視（前/次、Googleマップ等）
    if (currentTwFilter === label) el.classList.add('is-active');
    else el.classList.remove('is-active');
  });

  // フィルターONの間は操作を視覚的に無効化（統一版）
  const disable = isFilterOn();
  const idsToToggle = ['openPack', 'prevPack', 'nextPack', 'optimizeBtn'];
  idsToToggle.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-disabled', disable);
  });
}

// 起動時に一度だけ結線
(function bindTimeButtons(){
  const btns = Array.from(document.querySelectorAll('.btn-container .header-item'));
  const targets = new Set(timeWindows.filter(Boolean));
  btns.forEach(el => {
    const label = (el.textContent || '').trim();
    if (!targets.has(label)) return;
    el.addEventListener('click', () => setTwFilter(label));
  });
  syncFilterButtons();
})();

// 予測変換IIFEの先頭あたりに追記
const wardDictCache = new Map(); // wardCode -> dict JSON

async function getTownChomeList(wardName){
  const ward = TOKYO_WARDS[wardName];
  if (!ward) return [];
  if (!wardDictCache.has(ward.code)) {
    const dict = await loadWardIndex("東京都", wardName); // 既存関数
    wardDictCache.set(ward.code, dict);
  }
  const data = wardDictCache.get(ward.code)?.data || {};
  // "町|丁目" / "町|-" を表示用ラベルに変換
  return Object.keys(data)
    .filter(k => k !== "__CITY__|-|-")
    .map(k => {
      const [town, chome] = k.split("|");
      return {
        label: `${town}${(chome && chome !== "-") ? `${chome}丁目` : ""}`,
        anchorKey: k,
        wardCode: ward.code,
        wardName: wardName
      };
    });
}

// ── 区名の予測変換（東京都を最優先で候補に出す） ─────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("searchInput");
  const bar   = document.querySelector(".search-bar");
  if (!input || !bar || !window.TOKYO_WARDS) return;

  const box = document.createElement("ul");
  Object.assign(box.style, {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "4px",
    margin: 0,
    padding: "4px",
    listStyle: "none",
    zIndex: 2000,
    maxHeight: "200px",
    overflowY: "auto",
    fontSize: "14px"
  });
  box.id = "wardSuggest";
  box.style.display = "none";
  bar.appendChild(box);

  const PREF = "東京都";
  const WARDS = Object.keys(TOKYO_WARDS); // ["千代田区","中央区",...]

  let cur = -1;
 
  // ===============================================
  // 🚨 修正点 1: サジェスト生成ロジックを関数として独立させる
  // ===============================================

  /**
   * 検索入力値に基づいてサジェスト候補を更新するメインロジック。
   * 入力時、またはサジェスト項目クリック時に直接呼び出される。
   */
  async function updateSuggestions() {
    const q = input.value.trim();
    box.innerHTML = "";
    if (!q) { box.style.display = "none"; return; }

    // (ここから、元々 input.addEventListener("input", ...) の中にあったロジックを貼り付け)

    // まずは既存どおり：東京都/区の候補
    const wardHits = [];
    if (q === "東") {
      wardHits.push(...Object.keys(TOKYO_WARDS).map(w => `東京都${w}`));
    } else if (q === "東京" || q === "東京都" || "東京都".startsWith(q) || q.startsWith("東京都")) {
      const suffix = q.replace(/^東京都?/, "");
      wardHits.push(...Object.keys(TOKYO_WARDS).filter(w => !suffix || w.startsWith(suffix)).map(w => `東京都${w}`));
    } else {
      wardHits.push(...Object.keys(TOKYO_WARDS).filter(w => w.startsWith(q)).map(w => `東京都${w}`));
    }

    // ここから拡張：区が確定していれば町・丁目候補に切り替え
    const m = q.replace(/\s+/g, "").match(/^東京都?([^ ]+?区)(.*)$/);
    let finalList = wardHits; // デフォルトは従来の区候補
    if (m) {
      const wardName = m[1];
      const after = (m[2] || "");
      if (TOKYO_WARDS[wardName]) {
        const cand = await getTownChomeList(wardName);
        const qTown = after;
        const starts = cand.filter(c => c.label.startsWith(qTown));
        const parts  = cand.filter(c => !c.label.startsWith(qTown) && c.label.includes(qTown));
        const towns  = starts.concat(parts).slice(0, 12);
        if (towns.length) {
          // 町・丁目候補が見つかったら、最終候補リストを上書き
          finalList = towns.map(c => `東京都${wardName}${c.label}`);
        }
      }
    }

    if (!finalList.length) { box.style.display = "none"; return; }

    finalList.forEach(h => {
      const li = document.createElement("li");
      li.textContent = h;
      li.style.padding = "4px 8px";
      li.style.cursor = "pointer";
      
      // ===============================================
      // 🚨 修正点 2: li.click から dispatchEvent を削除し、関数を直接呼び出す
      // ===============================================
li.addEventListener("click", () => {
  const picked = h.trim();
  input.value = picked;
  input.focus(); // キーボード維持

  // 🚨 修正点：updateSuggestions() の呼び出しを setTimeout でラップし、
  // ブラウザのイベントキューの末尾で実行させることで、非同期処理の衝突を防ぐ。
  setTimeout(() => {
    updateSuggestions(); 
  }, 0); 

  // カーソルを末尾に
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch (_) {}
});

      box.appendChild(li);
    });
    box.style.display = "block";
  }; // updateSuggestions 関数の終わり

  // ===============================================
  // 🚨 修正点 3: input イベントリスナーは関数を呼び出すだけにする
  // ===============================================
  input.addEventListener("input", updateSuggestions);

  document.addEventListener("click", (e) => {
    if (!bar.contains(e.target)) box.style.display = "none";
  });
});

/* =========================
   互換用（window公開）
   ========================= */

window.__setSearchResult = (lat,lng,label)=>setSearchPin(lat,lng,label);

window.__fallbackSearch = (q)=>alert("住所正規化モジュールの読み込みに失敗しました。ネット接続 or ローカルサーバーでお試しください。");