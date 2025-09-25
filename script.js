// ===== Feature flags for Search (1-line) =====
const DETECTOR_MODE = 'dict'; // 'dict' | 'regex'  ← 既定は辞書アンカー
const SUGGEST_DEBOUNCE_MS = 120;
const SUGGEST_MAX = 20;

// ===== Minimal normalization for anchor =====
const nfkc = (s)=> (s||'').normalize('NFKC');
const unifyHyphen = (s)=> s.replace(/[‐-‒–—―ー−]/g, '-');
const squeezeSpaces = (s)=> s.replace(/\s+/g,' ').trim();
const stripPunct = (s)=> s.replace(/[、。．，！？「」『』（）［］〈〉＜＞…・：；]/g,'');
// 「丁目」直前の漢数字だけを算用に：十一丁目→11丁目（既存 jpNumToInt を流用）
function normalizeChomeOnly(s){
  const src = (s || '');
  return src.replace(/([〇一二三四五六七八九十百千万億兆]+)\s*丁目/g, (_,kanji)=>{
    try{ return `${jpNumToInt(kanji)}丁目`; }catch{ return _; }
  });
}
function normalizeForAnchor(input){
  return squeezeSpaces(
    stripPunct(
      unifyHyphen(
        nfkc(normalizeChomeOnly(input))
      )
    )
  );
}

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

/* ===== 時間帯フィルター（最小） ===== */
let currentTwFilter = null; // null=全件, 文字列=その時間帯のみ

const isFilterOn = () => currentTwFilter !== null;
const matchFilter = (p) => !isFilterOn() || p.tw === currentTwFilter;

function setTwFilter(twLabel) {
  // 同じボタンをもう一度押したら解除（ON/OFFトグル）
  currentTwFilter = (currentTwFilter === twLabel) ? null : twLabel;

  // ボタンの見た目だけ同期（.is-active付与/除去）
  syncFilterButtons();

  // 反映：描画は“表示制御のみ”
  renderMarkers();
  renderList();
  applyHighlight(); // フィルターON中は中でno-op化
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
        <button class="pin-btn c">C</button>
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

function clearPoint(marker, info){
  const ll = marker.getLatLng();

  if (info?.kind === 'route') {
    // id優先で消す（フォールバックで座標一致）
    route = route.filter(p => !(p.id===info.id || sameLL(p, ll)));
    try { map.removeLayer(marker); } catch(_){}
    renderMarkers(); renderList(); applyHighlight();

  } else if (info?.kind === 'search') {
    try { searchLayer.clearLayers(); } catch(_){}

  } else if (info?.kind === 'start') {
    if (startMarker) { try { map.removeLayer(startMarker); } catch(_){}
      startMarker=null; startPoint=null; renderList(); }

  } else if (info?.kind === 'goal') {
    if (goalMarker) { try { map.removeLayer(goalMarker); } catch(_){}
      goalMarker=null; goalPoint=null; renderList(); }
  }
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

    q('.pin-btn.c')?.addEventListener('click', () => {
      clearPoint(marker, info);
      marker.closePopup();
    });
    // ▼▼ 時間帯（案1：ボタン群）最小追加 ▼▼
if (info?.kind === 'route') {
  // 1) UIを差し込み
  const host = node.querySelector('.pin-popup') || node; // 既存のポップアップ内4
  const wrap = document.createElement('div');
  wrap.style.marginTop = '.5rem';
  wrap.innerHTML = `
    <div style="font-weight:700; margin: .25rem 0;">時間帯</div>
    <div class="pin-actions" style="justify-content:flex-start;">
      ${TW_LABELS.map(t => `<button class="pin-btn tw" data-tw="${t}">${t}</button>`).join('')}
      <button class="pin-btn tw" data-tw="">未割当</button>
    </div>
  `;
  host.appendChild(wrap);

  // 2) クリックで p.tw を更新
wrap.querySelectorAll('.pin-btn.tw').forEach(btn => {
  // 初期状態で選択されている時間帯に is-active を付ける
  if ((info?.tw || "") === btn.getAttribute('data-tw')) {
    btn.classList.add('is-active');
  }

  btn.addEventListener('click', () => {
    const tw = btn.getAttribute('data-tw') || null;
    const p = route.find(x => x.id === info.id);
    if (p) p.tw = tw || null;

    renderMarkers();
    renderList();
    marker.closePopup();
  });
});
}
// ▲▲ ここまで（案1） ▲▲
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

function removeRoutePoint(id){
  route = route.filter(p => p.id !== id);
  renderMarkers(); renderList(); applyHighlight();
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
// ▼▼ 時間帯割当（リスト版・省スペース&横スクロール）▼▼
const content = div.querySelector('.poi-content');  // 既存本文コンテナ
if (content) {
  const wrap = document.createElement('div');
  // 余白は .tw-strip 側で最小にしているのでここでは不要
  wrap.innerHTML = `
  <div class="tw-strip">
    ${timeWindows.filter(Boolean).map(t => 
      `<button class="tw-btn ${p.tw===t?'is-active':''}" data-tw="${t}">${t}</button>`
    ).join('')}
    <button class="tw-btn ${!p.tw?'is-active':''}" data-tw="">未割当</button>
  </div>
`;
  content.appendChild(wrap);

  const twButtons = wrap.querySelectorAll('.tw-btn');
  twButtons.forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();

      const twValue = btn.getAttribute('data-tw');

      twButtons.forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');

      p.tw = twValue ? twValue : null;

      renderMarkers();
      renderList();
    });
  });
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
  e.stopPropagation();  // カードのクリックで地図ジャンプが走らないように
  removeRoutePoint(p.id);
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

function openPack(){
  const beginIdx = packIndex * packSize;
  const endIdx   = Math.min(beginIdx + packSize, route.length) - 1;

  const toStr = pt => `${pt.lat},${pt.lng}`;
  const pts   = (beginIdx <= endIdx) ? route.slice(beginIdx, endIdx+1) : [];

  // origin/destination は S/G を優先
  let origin;
  if (startPoint) origin = toStr(startPoint);
  else if (packIndex===0 && pts[0]) origin = toStr(pts[0]);
  else if (packIndex>0 && route[beginIdx-1]) origin = toStr(route[beginIdx-1]);
  else origin = `${startEnd.lat},${startEnd.lng}`;

  let destination;
  if (goalPoint) destination = toStr(goalPoint);
  else if (pts.length) destination = toStr(pts[pts.length-1]);
  else destination = origin;

  const waypoints = pts.length > 1 ? pts.slice(0,-1).map(toStr).join('|') : '';
  const url = `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    (waypoints?`&waypoints=${encodeURIComponent(waypoints)}`:'') +
    `&travelmode=driving`;
  window.open(url,"_blank");
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

  const { town, chome } = townChomeFrom(nja.town);
  const data = dict.data || {};
  const hit = data[`${town}|${chome ?? "-"}`] || data[`${town}|-|`] || data[`__CITY__|-|-`];
  if (!hit) return { ok:false, reason:"辞書に該当なし" };

  return {
    ok: true,
    lat: hit.lat, lng: hit.lng, level: hit.level,
    label: (nja.town||"") + (chome ? `${chome}丁目` : "")
  };
}

// 検索結果ピン（ポップアップ含む）
function setSearchPin(lat,lng,label){
  searchLayer.clearLayers();
  const title = label || "検索地点";
  const m = L.marker([lat,lng]).addTo(searchLayer)
    .bindPopup(makePinPopupHTML(title));

  // 先に wirePopup を仕込んでから
  wirePopup(m, { kind: 'search', label: title });

  // その後に openPopup
  m.openPopup();

  map.setView([lat,lng], Math.max(map.getZoom(),15), {animate:true});
  return m;
}

// 検索バーに × を挿入（最適化ボタンと重ならないように動的に右余白を算出）
(function initSearchClear(){
  const bar   = document.querySelector('.search-bar');
  const input = document.getElementById('searchInput');
  const opt   = document.getElementById('searchBtn'); // ← 最適化ボタンに転用済み
  if (!bar || !input) return;

  let clearBtn = bar.querySelector('.search-clear');
  if(!clearBtn){
    clearBtn = document.createElement('button');
    clearBtn.className = 'search-clear';
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label','クリア');
    clearBtn.textContent = '×';
    bar.appendChild(clearBtn);
  }

  // 最適化ボタンの実寸から、×の right を決める
  function placeClear(){
    // ボタンが無ければ従来の 2.5rem
    let right = 40; // px
    if (opt) {
      const w = Math.ceil(opt.getBoundingClientRect().width); // 実幅
      right = w - 3; // ボタン幅 + ちょい間隔
    }
    clearBtn.style.right = right + 'px';
  }

  const toggle = ()=> {
    const v = (input.value || '').trim();
    clearBtn.style.display = v ? 'inline-flex' : 'none';
    placeClear();
  };

  input.addEventListener('input', toggle);
  input.addEventListener('keydown', e => {
    if(e.key==='Escape'){ input.value=''; input.dispatchEvent(new Event('input')); input.focus(); }
  });
  clearBtn.addEventListener('click', ()=>{ input.value=''; input.dispatchEvent(new Event('input')); input.focus(); });

  // リサイズやフォント計測後にも位置を調整
  window.addEventListener('resize', placeClear);
  setTimeout(placeClear, 0);
  toggle();
})();

// 検索ボタン/Enter
async function onSearch(){
  // 新：辞書アンカー方式（regex 抽出は無効化）
  if (DETECTOR_MODE !== 'dict') return;
  // 辞書アンカーは UI 側（区/町/丁目）で確定後に runAnchoredSearch() を呼ぶ
  // ここでは何もしない（既存ハンドラを温存する場合は無効化してOK）
}
searchBtn?.addEventListener("click", onSearch);
searchInput?.addEventListener("keydown", e => { if(e.key==="Enter") onSearch(); });

// 置き換え（最適化ボタン転用部）
const optimizeBtn = document.getElementById('searchBtn');
if (optimizeBtn) {
  optimizeBtn.textContent = '最適化';
  optimizeBtn.onclick = () => { if (typeof isFilterOn==='function' && isFilterOn()) return; optimizeRoute(); };
}

/* =========================
   ヘッダーボタン連携
   ========================= */

// 置き換え（既存の3行をこの3行に）
document.getElementById('openPack').onclick=()=>{ if (typeof isFilterOn==='function' && isFilterOn()) return; openPack(); };
document.getElementById('nextPack').onclick=()=>{ if (typeof isFilterOn==='function' && isFilterOn()) return; packIndex++; if(packIndex*packSize>=route.length) packIndex=0; applyHighlight(); };
document.getElementById('prevPack').onclick=()=>{ if (typeof isFilterOn==='function' && isFilterOn()) return; packIndex--; if(packIndex<0) packIndex=Math.floor((route.length-1)/packSize); applyHighlight(); };

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

  // ついでに、フィルターONの間は一部操作を視覚的にも無効化
  const disable = isFilterOn();
  const idsToToggle = ['openPack','prevPack','nextPack','searchBtn']; // パック系のみ見た目無効化（安全）
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

/* =========================
   互換用（window公開）
   ========================= */

window.__setSearchResult = (lat,lng,label)=>setSearchPin(lat,lng,label);

window.__fallbackSearch = (q)=>alert("住所正規化モジュールの読み込みに失敗しました。ネット接続 or ローカルサーバーでお試しください。");
