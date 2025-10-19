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

// ゴールを考慮した2-opt（S → 経由地 → G の全体距離を最小化）
function twoOptWithGoal(route, start, goal){
  // 総距離計算：S → 経由地1 → 経由地2 → ... → G
  function totalWithGoal(seq){
    let d = 0;
    let cur = start;
    for (const p of seq) {
      d += haversine(cur, p);
      cur = p;
    }
    d += haversine(cur, goal); // 最後の経由地 → G
    return d;
  }
  
  let best = route.slice();
  let bestD = totalWithGoal(best);
  const n = best.length;
  let improved = true;
  
  while(improved){
    improved = false;
    for(let i = 0; i < n - 1; i++){
      for(let k = i + 1; k < n; k++){
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const d = totalWithGoal(cand);
        if(d + 1e-9 < bestD){
          best = cand;
          bestD = d;
          improved = true;
        }
      }
    }
  }
  
  return best;
}

let route = []; // 空の状態でスタート

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

/* =========================
   地図フォーカス統一関数
   ========================= */

// 個別地点にフォーカス（Googleマップ風）
function focusOnPoint(lat, lng, marker = null) {
  // ズーム：17固定、アニメーションなし
  map.setView([lat, lng], 17, { animate: false });
  
  // リストパネルを閉じる
  listPanel.classList.remove('open');
  listPanel.style.transform = 'translateY(calc(100% - 4.5rem))';
  setTimeout(() => map.invalidateSize(), 80);
  
  // ポップアップを開く（マーカーが指定されている場合）
  if (marker) {
    setTimeout(() => marker.openPopup(), 100);
  }
}

// 全ピンを表示（最適化用）
function showAllPins() {
  const bnds = L.latLngBounds([]);
  
  // S/Gを含める
  if (startPoint) bnds.extend([startPoint.lat, startPoint.lng]);
  if (goalPoint) bnds.extend([goalPoint.lat, goalPoint.lng]);
  
  // 全経由地を含める
  route.forEach(p => {
    if (p.lat !== null && p.lng !== null) {
      bnds.extend([p.lat, p.lng]);
    }
  });
  
  if (bnds.isValid()) {
    map.fitBounds(bnds.pad(0.1));
  }
}

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
function setAsStart(lat, lng, label, status = 'SUCCESS') {
  
  // 既存のSを削除
  if (startMarker) {
    try { map.removeLayer(startMarker); } catch(_){}
  }
  startMarker = L.marker([lat, lng], { icon: greenIcon }).addTo(map);

  // バッジ付きタイトル
  const badge = getStatusBadge(status);
  const title = `出発：${label} ${badge}`;
  
  // ボタン付きポップアップ + 先に wire
  startMarker.bindPopup(makePinPopupHTML(title));
  wirePopup(startMarker, { kind: 'start', label, status });

  // S バッジ
  startMarker.bindTooltip("S", { permanent: true, direction: 'top', className: 'sg-tip-start' });

  startPoint = { lat, lng, label, status };
  renderList();
  
  // 統一関数を使用
  focusOnPoint(lat, lng, startMarker);
}

// 目的地に設定
function setAsGoal(lat, lng, label, status = 'SUCCESS') {
  
  // 既存のGを削除
  if (goalMarker) {
    try { map.removeLayer(goalMarker); } catch(_){}
  }
  goalMarker = L.marker([lat, lng], { icon: redIcon }).addTo(map);

  // バッジ付きタイトル
  const badge = getStatusBadge(status);
  const title = `到着：${label} ${badge}`;
  
  // ボタン付きポップアップ + 先に wire
  goalMarker.bindPopup(makePinPopupHTML(title));
  wirePopup(goalMarker, { kind: 'goal', label, status });

  // G バッジ
  goalMarker.bindTooltip("G", { permanent: true, direction: 'top', className: 'sg-tip-goal' });

  goalPoint = { lat, lng, label, status };
  renderList();
  // 統一関数を使用
  focusOnPoint(lat, lng, goalMarker);
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
      
      // G→S変換の場合はGを削除
      if (info?.kind === 'goal') {
        if (goalMarker) {
          try { map.removeLayer(goalMarker); } catch(_){}
          goalMarker = null;
          goalPoint = null;
        }
      }
      
      // ルート上の点をSに昇格させたら、重複を避けるため除外
      if (AUTO_REMOVE_ROUTE_ON_SET_SG && info?.kind==='route') {
        route = route.filter(p => p.id !== info.id);
        try { map.removeLayer(marker); } catch(_){}
      }
      
      setAsStart(lat, lng, label, info?.status || 'SUCCESS');
      renderMarkers(); renderList();
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
  addVia(lat, lng, label, info?.status || 'SUCCESS');
  marker.closePopup();
});

    q('.pin-btn.goal')?.addEventListener('click', () => {
      const { lat, lng } = getLL();
      
      // S→G変換の場合はSを削除
      if (info?.kind === 'start') {
        if (startMarker) {
          try { map.removeLayer(startMarker); } catch(_){}
          startMarker = null;
          startPoint = null;
        }
      }
      
      // ルート上の点をGに昇格させたら、重複を避けるため除外
      if (AUTO_REMOVE_ROUTE_ON_SET_SG && info?.kind==='route') {
        route = route.filter(p => p.id !== info.id);
        try { map.removeLayer(marker); } catch(_){}
      }
      
      setAsGoal(lat, lng, label, info?.status || 'SUCCESS');
      renderMarkers(); renderList();
      marker.closePopup();
    });
    
    q('.pin-btn.edit')?.addEventListener('click', () => {
      openAddressEditModal(info?.label || '地点', (result) => {
        
        // FAILEDの場合
        if (result.status === 'FAILED') {
          const ok = confirm(
            `${result.label} ✗\n\n` +
            `このアプリではヒットしませんでした。\n\n` +
            `Googleマップでは開ける場合がほとんどです。\n` +
            `ピンは立ちませんので順番は手動で並び替えてください。\n\n` +
            `座標なしでリストに追加しますか？`
          );
          
          if (!ok) return;
          
          // 座標なしで更新（種類別）
          if (info.kind === 'search') {
            // 検索ピンは座標なしでは表示できないので削除
            alert('検索ピンは座標が必要なため更新できません。');
            return;
            
          } else if (info.kind === 'route') {
            const p = route.find(x => x.id === info.id);
            if (p) {
              p.lat = null;
              p.lng = null;
              p.label = result.label;
              p.status = 'FAILED';
            }
            renderMarkers();
            renderList();
            
          } else if (info.kind === 'start' || info.kind === 'goal') {
            alert('出発地・目的地は座標が必要なため更新できません。');
            return;
          }
          
          return;
        }
        
        // 種類別に反映
        if (info.kind === 'search') {
          // 検索ピンを更新（検索窓と同じ: ズーム+ポップアップ表示）
          setSearchPin(result.lat, result.lng, result.label, result.status);
          
        } else if (info.kind === 'route') {
          // 経由地を更新
          const p = route.find(x => x.id === info.id);
          if (p) {
            p.lat = result.lat;
            p.lng = result.lng;
            p.label = result.label;
            p.status = result.status;
          }
          renderMarkers();
          renderList();
          
          // 統一関数を使用
          setTimeout(() => {
            const newMarker = markers.find((m, idx) => route[idx]?.id === info.id);
            if (newMarker) focusOnPoint(result.lat, result.lng, newMarker);
          }, 100);
          
        } else if (info.kind === 'start') {
          // 出発地を更新（統一関数が自動でポップアップを開く）
          setAsStart(result.lat, result.lng, result.label, result.status);
          
        } else if (info.kind === 'goal') {
          // 目的地を更新（統一関数が自動でポップアップを開く）
          setAsGoal(result.lat, result.lng, result.label, result.status);
        }
        });
    });
    
    // 削除ボタン
    q('.pin-btn.delete')?.addEventListener('click', () => {
      const ok = confirm('この地点を削除しますか？');
      if (!ok) return;
      
      deletePoint(info?.kind, info);
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

/* =========================
   重複チェック（共通関数）
   ========================= */

// 既存ルートとの重複判定（確認付き）
function isDuplicateInRoute(lat, lng, label, askUser = true) {
  if (lat === null || lng === null) return false;
  
  const dup = route.find(p => 
    sameLL(p, {lat, lng}) && p.label === label
  );
  
  if (!dup) return false; // 重複なし
  
  // 重複あり：ユーザーに確認
  if (askUser) {
    return !confirm(
      `「${label}」は既に登録されています。\n\n` +
      `同じ場所を複数回訪問する場合は「OK」を押してください。`
    );
  }
  
  return true; // 確認なしの場合は重複として扱う
}

function addVia(lat, lng, label, status = 'SUCCESS') {
  // 重複チェック（共通関数を使用）
  if (isDuplicateInRoute(lat, lng, label)) return;

  const nextId = Math.max(0, ...route.map(p => p.id || 0)) + 1;
  route.push({ 
    id: nextId, 
    label: label || '経由地', 
    lat, 
    lng, 
    tw: null,
    status: status
  });

  renderMarkers(); renderList();
  
  // 座標がある場合のみフォーカス
  if (lat !== null && lng !== null) {
    setTimeout(() => {
      const newMarker = markers[markers.length - 1];
      focusOnPoint(lat, lng, newMarker);
    }, 100);
  }
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

  // 起点
  const startAnchor = startPoint || unlocked[0];

  // ゴールを考慮した最適化
  if (goalPoint) {
    // S → 経由地 → G の全体距離を最小化
    let optimized = twoOptWithGoal(nearestNeighbor(unlocked, startAnchor), startAnchor, goalPoint);
    
    // ロック位置を維持してマージ
    const merged = new Array(route.length);
    lockedSlots.forEach(({idx,p}) => merged[idx] = p);
    let up = 0;
    for (let i=0; i<merged.length; i++){
      if (!merged[i]) merged[i] = optimized[up++];
    }
    route = merged;
    
  } else {
    // Gなし：従来の巡回最適化
    let optimized = twoOpt(nearestNeighbor(unlocked, startAnchor), startAnchor);
    
    const merged = new Array(route.length);
    lockedSlots.forEach(({idx,p}) => merged[idx] = p);
    let up = 0;
    for (let i=0; i<merged.length; i++){
      if (!merged[i]) merged[i] = optimized[up++];
    }
    route = merged;
  }

  renderMarkers(); renderList(); 
  
  // パック状態をリセットして最初の10件を表示
  packIndex = 0;
  hasShownPack = true;
  applyHighlight(); // 即座に赤枠表示
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
     if (!matchFilter(p)) return;
     
     // 座標なし（FAILED）はピンを立てない
     if (p.lat === null || p.lng === null) return;
     
     // バッジ付きタイトル
     const badge = getStatusBadge(p.status || 'SUCCESS');
     const title = `${i+1}. ${p.label} ${badge}${p.tw?`（⏰${p.tw}）`:""}`;
     
     const m = L.marker([p.lat,p.lng]).addTo(map)
      .bindPopup(makePinPopupHTML(title));
    m.bindTooltip(String(i+1), { permanent: true, direction: 'top', className: 'idx-tip', offset: [-10, -4] });

    wirePopup(m, { kind: 'route', label: p.label, id: p.id, index: i, tw: p.tw });

    markers.push(m);
    bounds.extend([p.lat,p.lng]);
  });
  // fitBounds は最適化やパック表示の時だけ行う
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
  map.setView([startEnd.lat, startEnd.lng], 13);
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
    const badge = getStatusBadge(startPoint.status || 'SUCCESS');
    s.innerHTML = `
      <div class="badge" style="background:#22c55e;">S</div>
      <div class="poi-content">
        <div class="poi-name">出発：${startPoint.label} ${badge}</div>
      </div>
      <button class="del-btn" aria-label="削除" title="削除">🗑️</button>`;
    
    // 削除ボタン
    const delBtn = s.querySelector('.del-btn');
    delBtn.onclick = (e) => {
      e.stopPropagation();
      const ok = confirm('出発地を削除しますか？');
      if (ok) deletePoint('start');
    };
    s.onclick = () => {
      focusOnPoint(startPoint.lat, startPoint.lng, startMarker);
    };
    listEl.appendChild(s);
  }

  // --- 経由地（ドラッグ可） ---
  route.forEach((p,i)=>{
    if (!matchFilter(p)) return;
    
    const div=document.createElement('div');
    div.className='poi-card'; div.setAttribute('draggable','true'); div.dataset.id=p.id;
    
    // 座標なし（FAILED）の場合はバッジをグレー表示
    const badgeStyle = (p.lat === null || p.lng === null) 
      ? 'background:#9ca3af;color:#fff' 
      : 'background:#4285F4;color:#fff';
    
    div.innerHTML = `
  <div class="badge" id="badge-${i}" style="${badgeStyle}">${i+1}</div>
  <button class="lock-btn" aria-label="固定/解除" title="固定/解除">🔓</button>

  <div class="poi-content">
    <div class="poi-name">
      ${p.label} ${getStatusBadge(p.status || 'SUCCESS')}${p.tw ? `<span class="tw-badge">⏰ ${p.tw}</span>` : ""}
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
  
  // Gマップ + 編集 + 時間帯ボタン
  wrap.innerHTML = `
  <div class="tw-strip">
    <button class="tw-btn gmaps-btn">Gマップ</button>
    <button class="tw-btn edit-btn">✏️</button>
    ${twUI.html}
  </div>`;
  content.appendChild(wrap);
  
  // Gマップボタンのイベント
  wrap.querySelector('.gmaps-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openInGoogleMapsAddress(p.label, { normalize: false });
  });
  
  // 編集ボタンのイベント
  wrap.querySelector('.edit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    
    openAddressEditModal(p.label, (result) => {
      if (result.status === 'FAILED') {
        const ok = confirm(
          `${result.label} ✗\n\n` +
          `このアプリではヒットしませんでした。\n\n` +
          `Googleマップでは開ける場合がほとんどです。\n` +
          `ピンは立ちませんので順番は手動で並び替えてください。\n\n` +
          `座標なしでリストに追加しますか？`
        );
        
        if (!ok) return;
        
        p.lat = null;
        p.lng = null;
        p.label = result.label;
        p.status = 'FAILED';
        
        renderMarkers();
        renderList();
        return;
      }
      
      // 経由地を更新
      p.lat = result.lat;
      p.lng = result.lng;
      p.label = result.label;
      p.status = result.status;
      
      renderMarkers();
      renderList();
      
      // 統一関数を使用
      setTimeout(() => {
        const newMarker = markers.find((m, idx) => route[idx]?.id === p.id);
        if (newMarker) focusOnPoint(result.lat, result.lng, newMarker);
      }, 100);
    });
  });
  
  // 時間帯ボタンのイベント
  twUI.wire(wrap);
}

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
  const ok = confirm(`${p.label} を削除しますか？`);
  if (ok) deletePoint('route', { id: p.id });
};


// ロック中はドラッグ系を無効化
div.addEventListener('dragstart', e=>{ if(p.locked){ e.preventDefault(); return; } e.dataTransfer.setData('text/plain',p.id.toString()); setTimeout(()=>div.style.opacity='.5',0); });
div.addEventListener('dragover', e=>{ if(p.locked){ return; } e.preventDefault(); div.classList.add('drag-over'); });


    // カードクリックで地図へジャンプ
    div.onclick=()=>{ 
      const marker = markers.find((m, idx) => route[idx]?.id === p.id);
      focusOnPoint(p.lat, p.lng, marker);
    };

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
    const badge = getStatusBadge(goalPoint.status || 'SUCCESS');
    g.innerHTML = `
      <div class="badge" style="background:#ef4444;">G</div>
      <div class="poi-content">
        <div class="poi-name">目的地：${goalPoint.label} ${badge}</div>
      </div>
      <button class="del-btn" aria-label="削除" title="削除">🗑️</button>`;
    
    // 削除ボタン
    const delBtn = g.querySelector('.del-btn');
    delBtn.onclick = (e) => {
      e.stopPropagation();
      const ok = confirm('目的地を削除しますか？');
      if (ok) deletePoint('goal');
    };
    g.onclick = () => {
      focusOnPoint(goalPoint.lat, goalPoint.lng, goalMarker);
    };
    listEl.appendChild(g);
  }

  if (listPanel.classList.contains('open')) layoutListPanel();

  // ★ 追加：自動スクロールを一度だけバインド
  bindAutoScrollForList();
}

/* =========================
   パック強調 / Googleマップ連携
   ========================= */

let packIndex=0; const packSize=10;
let hasShownPack = false; // パック表示フラグ

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
  const pts = route.slice(beginIdx, beginIdx + 10);

  if (!pts.length) return;

  const toParam = (pt) => pointToMapsParam(pt, { normalize: true });

  const origin = (packIndex === 0 && startPoint) ? toParam(startPoint) : (packIndex > 0 ? toParam(route[beginIdx - 1]) : undefined);
  const destination = (beginIdx + 10 >= route.length && goalPoint) ? toParam(goalPoint) : toParam(pts[pts.length - 1]);
  const waypoints = pts.map(toParam).join('|');

  const url = `https://www.google.com/maps/dir/?api=1`
    + (origin ? `&origin=${encodeURIComponent(origin)}` : '')
    + `&destination=${encodeURIComponent(destination)}`
    + `&waypoints=${encodeURIComponent(waypoints)}`
    + `&travelmode=driving`;

  window.open(url, "_blank");
  packIndex++; applyHighlight();
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
// 一括プレビューデータ（ジオコーディング結果を保持）
let bulkPreviewData = [];

bulkOpen?.addEventListener('click', () => {
  bulkPanel.style.display = 'block';
  setTimeout(()=>map.invalidateSize(), 80);
});
bulkClose?.addEventListener('click', () => {
  bulkPanel.style.display = 'none';
  setTimeout(()=>map.invalidateSize(), 80);
});

// ▼ 「住所だけ抽出」ボタン処理（1件=1〜2行＋区切り線）
extractBtn?.addEventListener('click', async () => {
  const src = bulkInput.value || '';
  const progressEl = document.getElementById('bulkProgress');
  
  // プログレス表示開始
  progressEl.textContent = '処理中...';
  
  const ents = await extractEntries(src, (current, total) => {
    // 進捗更新コールバック
    progressEl.textContent = `${current}/${total}`;
  });
  
  if (!ents.length) {
    progressEl.textContent = '';
    alert('住所が見つかりません');
    return;
  }
  
  // 完了後もそのまま残す（サマリー）
  progressEl.textContent = `${ents.length}件`;
  
  // 入力エリアを非表示、プレビューを表示
  document.getElementById('bulkInputArea').style.display = 'none';
  document.getElementById('bulkPreview').style.display = 'block';
  
  // ボタン表示を切り替え
  document.getElementById('extractBtn').style.display = 'none';
  document.getElementById('bulkBack').style.display = 'inline-block';
  document.getElementById('bulkClearInput').style.display = 'none';
  document.getElementById('bulkDelete').style.display = 'inline-block';
  
  // プレビューリストを生成
  const previewList = document.getElementById('bulkPreviewList');
  previewList.innerHTML = '';
  
  // プレビューデータを初期化
  bulkPreviewData = ents.map((e, idx) => {
    const label = e.addr2 ? `${e.addr1} ${e.addr2}` : e.addr1;
    return {
      idx,
      label,
      status: 'PENDING', // 初期状態
      lat: null,
      lng: null
    };
  });
  
  // カード生成
  bulkPreviewData.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'bulk-preview-card';
    card.dataset.idx = item.idx;
    card.innerHTML = `
      <input type="checkbox" class="bulk-checkbox" checked data-idx="${item.idx}" />
      <span class="bulk-address">${item.label} <span class="status-badge">⏳</span></span>
      <button class="bulk-edit-btn" data-idx="${item.idx}">✏️</button>
    `;
    previewList.appendChild(card);
  });
  
  // 編集ボタンのイベント（デリゲーション）
  previewList.addEventListener('click', (e) => {
    if (!e.target.classList.contains('bulk-edit-btn')) return;
    
    const idx = parseInt(e.target.dataset.idx, 10);
    const item = bulkPreviewData.find(x => x.idx === idx);
    if (!item) return;
    
    openAddressEditModal(item.label, (result) => {
      if (result.status === 'FAILED') {
        const ok = confirm(
          `${result.label} ✗\n\n` +
          `このアプリではヒットしませんでした。\n\n` +
          `Googleマップでは開ける場合がほとんどです。\n` +
          `ピンは立ちませんので順番は手動で並び替えてください。\n\n` +
          `座標なしでリストに追加しますか？`
        );
        
        if (!ok) return;
        
        item.status = 'FAILED';
        item.lat = null;
        item.lng = null;
        item.label = result.label;
        
        const card = document.querySelector(`.bulk-preview-card[data-idx="${idx}"]`);
        if (card) {
          const badge = getStatusBadge('FAILED');
          const addressSpan = card.querySelector('.bulk-address');
          addressSpan.innerHTML = `${result.label} ${badge}`;
        }
        return;
      }
      
      // 結果を保存
      item.status = result.status;
      item.lat = result.lat;
      item.lng = result.lng;
      item.label = result.label;
      
      // カードを更新
      const card = document.querySelector(`.bulk-preview-card[data-idx="${idx}"]`);
      if (card) {
        const badge = getStatusBadge(result.status);
        const addressSpan = card.querySelector('.bulk-address');
        addressSpan.innerHTML = `${result.label} ${badge}`;
      }
    });
  });
  
  // 自動でジオコーディング開始
  bulkGeocode();
});

// 一括ジオコーディング処理
async function bulkGeocode() {
  for (const item of bulkPreviewData) {
    try {
      const result = await geocodeAndClassify(item.label);
      
      // 結果を保存
      item.status = result.status;
      item.lat = result.lat;
      item.lng = result.lng;
      item.label = result.label; // 正規化後のラベル
      
      // カードのバッジを更新
      const card = document.querySelector(`.bulk-preview-card[data-idx="${item.idx}"]`);
      if (card) {
        const badge = getStatusBadge(result.status);
        const addressSpan = card.querySelector('.bulk-address');
        addressSpan.innerHTML = `${result.label} ${badge}`;
      }
      
    } catch (e) {
      console.error('ジオコーディングエラー:', e);
      item.status = 'FAILED';
      
      const card = document.querySelector(`.bulk-preview-card[data-idx="${item.idx}"]`);
      if (card) {
        const badge = getStatusBadge('FAILED');
        const addressSpan = card.querySelector('.bulk-address');
        addressSpan.innerHTML = `${item.label} ${badge}`;
      }
    }
  }
}

// ▼ 一括「取り込み」：住所だけをルートに追加（先に即時表示→あとで順次ジオコーディング）
addBtn?.addEventListener('click', () => {
  // チェックされたインデックスを取得
  const checkedIndexes = Array.from(document.querySelectorAll('.bulk-checkbox:checked'))
    .map(cb => parseInt(cb.dataset.idx, 10));
  
  if (!checkedIndexes.length) {
    alert('追加する住所を選択してください');
    return;
  }
  
  // チェック入りのデータのみ取得
  const selectedItems = bulkPreviewData.filter(item => checkedIndexes.includes(item.idx));
  
  // 重複チェック
  const duplicates = selectedItems.filter(item => 
    isDuplicateInRoute(item.lat, item.lng, item.label, false)
  );
  
  // 重複があれば確認
  if (duplicates.length > 0) {
    const dupList = duplicates.map(d => d.label).join('\n');
    const ok = confirm(
      `以下の住所は既に登録されています：\n\n${dupList}\n\n` +
      `同じ場所を複数回訪問する場合は「OK」を押してください。`
    );
    
    if (!ok) return; // キャンセル → プレビューモードに戻る
  }
  
  // FAILEDが含まれている場合は警告
  const failedCount = selectedItems.filter(item => item.status === 'FAILED').length;
  if (failedCount > 0) {
    const ok = confirm(`${failedCount}件の住所は座標を取得できませんでした。\nこのまま追加しますか？\n（座標なしでもGoogleマップで開けます）`);
    if (!ok) return;
  }
  
  // ルートに追加
  const nextIdBase = Math.max(0, ...route.map(x => x.id || 0)) + 1;
  
  selectedItems.forEach((item, i) => {
    route.push({
      id: nextIdBase + i,
      label: item.label,
      lat: item.lat,
      lng: item.lng,
      status: item.status,
      tw: null
    });
  });
  
  // UI更新
  renderMarkers();
  renderList();
  
  // 全ピンを表示
  showAllPins();
  
  // リストパネルを開く
  listPanel.classList.add('open');
  layoutListPanel();
  setTimeout(() => map.invalidateSize(), 80);
  
  // 一括パネルを閉じる
  bulkPanel.style.display = 'none';
  
  // 入力モードに戻す
  document.getElementById('bulkPreview').style.display = 'none';
  document.getElementById('bulkInputArea').style.display = 'block';
  document.getElementById('extractBtn').style.display = 'inline-block';
  document.getElementById('bulkBack').style.display = 'none';
  document.getElementById('bulkClearInput').style.display = 'inline-block';
  document.getElementById('bulkDelete').style.display = 'none';
  
  // テキストエリアをクリア
  bulkInput.value = '';
  
  // プログレス表示をクリア
  document.getElementById('bulkProgress').textContent = '';
  
  // プレビューデータをリセット
  bulkPreviewData = [];
});


// 住所抽出（njaベース・新版）
async function extractEntries(text) {
  const { normalize } = await import("https://esm.sh/@geolonia/normalize-japanese-addresses");
  
  const lines = (text || '')
    .split(/\r?\n/)
    .map(line => normalizeAddressInput(line))
    .filter(line => line && line.length > 3); // 短すぎる行は除外
  
  const entries = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    
    try {
      const nja = await normalize(line);
      
      // 住所判定：city（区）があればOK
      if (nja.city) {
        let addr1 = line;
        const buildingParts = [];
        let consumed = 0;
        
        // 次の1〜4行をスキャン
        for (let j = 1; j <= 4 && i + j < lines.length; j++) {
          const next = lines[i + j];
          
          // スキップ条件：郵便番号・配達指示・宛名・電話など
          if (/^〒|^配達|^到着|^注文|^TEL|^電話|^メモ|^スキャン|様$|御中$|殿$/.test(next)) {
            break;
          }
          
          // 次の住所が来たら終了
          try {
            const nextNja = await normalize(next);
            if (nextNja.city) break; // 区が出たら次の住所
          } catch(_) {}
          
          // 番地の続き（2-8-12 など）
          if (/^\d{1,3}-\d/.test(next)) {
            addr1 += ` ${next}`;
            consumed = j;
            continue;
          }
          
          // 建物名・部屋番号
          if (isBuildingOrRoomLine(next)) {
            buildingParts.push(next);
            consumed = j;
          }
        }
        
        // 建物情報を結合
        const addr2 = buildingParts.join(' ');
        entries.push({ addr1, addr2 });
        
        i += consumed + 1;
        continue;
      }
      
      i++;
      
    } catch (e) {
      i++;
      continue;
    }
  }
  
  // 同じテキスト内での重複をチェック
  const seen = new Map();
  const duplicates = [];
  
  for (const entry of entries) {
    const key = `${entry.addr1}|${entry.addr2 || ''}`;
    if (seen.has(key)) {
      duplicates.push(entry.addr1 + (entry.addr2 ? ` ${entry.addr2}` : ''));
    } else {
      seen.set(key, true);
    }
  }
  
  // 重複があれば通知
  if (duplicates.length > 0) {
    alert(
      `以下の${duplicates.length}件は同じテキスト内で重複しています：\n\n` +
      duplicates.join('\n') +
      `\n\n不要な場合はチェックを外してください。`
    );
  }
  
  // 重複も含めてすべて返す（ユーザーが判断）
  return entries;
}

// 建物名・部屋番号判定（拡張版）
function isBuildingOrRoomLine(line) {
  // 建物キーワード
  if (/ビル|タワー|マンション|アパート|ハイツ|コーポ|メゾン|ヒルズ|レジデンス|パーク|ガーデン|サイド|ヴィラ/.test(line)) return true;
  
  // 部屋番号パターン
  if (/\d{1,4}号室?$/.test(line)) return true;           // 302号室
  if (/[A-Z]-\d{1,4}$/.test(line)) return true;          // A-101
  if (/\d{1,2}[階F]$/.test(line)) return true;           // 12F
  
  // 確実に住所ではない（都道府県・区市町村を含まない）
  if (/東京都|[都道府県]|[区市町村]/.test(line)) return false;
  
  // 短い行でカタカナのみ（建物名の可能性）
  if (line.length < 25 && /^[ァ-ヶー\s]+/.test(line)) return true;
  
  return false;
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
    'SUCCESS': '<span class="status-badge status-success">✓<sup class="help-icon" data-help="success">ⓘ</sup></span>',
    'PARTIAL': '<span class="status-badge status-partial">⚠<sup class="help-icon" data-help="partial">ⓘ</sup></span>',
    'FAILED': '<span class="status-badge status-failed">✗<sup class="help-icon" data-help="failed">ⓘ</sup></span>'
  };
  return badges[status] || '';
}

// 住所編集モーダルを開く（ステップ1：UI表示のみ）
function openAddressEditModal(currentAddress, onComplete) {
  // 既存のモーダルがあれば削除
  const existing = document.getElementById('edit-modal');
  if (existing) existing.remove();
  
  // モーダル要素を作成
  const modal = document.createElement('div');
  modal.id = 'edit-modal';
  modal.className = 'edit-modal';
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-title">住所を編集</div>
      </div>
      <div class="modal-body">
        <input type="text" class="modal-input" value="${currentAddress}" />
        <div class="modal-status">住所を修正して「再検索」を押してください</div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn cancel">キャンセル</button>
        <button class="modal-btn search">再検索</button>
      </div>
    </div>`;
  
  document.body.appendChild(modal);
  
  // キャンセルボタン（動作確認用）
  modal.querySelector('.cancel').onclick = () => {
    document.body.removeChild(modal);
  };
  
  // 再検索ボタン
  modal.querySelector('.search').onclick = async () => {
    const input = modal.querySelector('.modal-input');
    const statusDiv = modal.querySelector('.modal-status');
    const searchBtn = modal.querySelector('.search');
    
    const raw = (input.value || '').trim();
    if (!raw) {
      statusDiv.textContent = '住所を入力してください';
      statusDiv.style.color = '#ef4444';
      return;
    }
    
    // ボタンを無効化（二重送信防止）
    searchBtn.disabled = true;
    searchBtn.textContent = '検索中...';
    statusDiv.textContent = 'ジオコーディング中...';
    statusDiv.style.color = '#6b7280';
    
    try {
      // 正規化（検索窓と同じ）
      const normalized = normalizeAddressInput(raw);
      input.value = normalized;
      
      // ジオコーディング（検索窓と同じ）
      const result = await geocodeAndClassify(normalized);
      
      // 結果をコールバックで返す
      onComplete(result);
      
      // モーダルを閉じる
      document.body.removeChild(modal);
      
    } catch (e) {
      console.error(e);
      statusDiv.textContent = 'エラーが発生しました: ' + (e.message || '不明なエラー');
      statusDiv.style.color = '#ef4444';
      searchBtn.disabled = false;
      searchBtn.textContent = '再検索';
    }
  };
  
  // オーバーレイクリックで閉じる
  modal.querySelector('.modal-overlay').onclick = () => {
    document.body.removeChild(modal);
  };
  
  // Enterキーで再検索
  modal.querySelector('.modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      modal.querySelector('.search').click();
    }
  });
  
  // サジェスト機能（検索窓と同じ軽量版）
  const input = modal.querySelector('.modal-input');
  const suggestBox = document.createElement('ul');
  Object.assign(suggestBox.style, {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '0.5rem',
    margin: 0,
    padding: '4px',
    listStyle: 'none',
    zIndex: 10,
    maxHeight: '200px',
    overflowY: 'auto',
    fontSize: '0.875rem',
    display: 'none'
  });
  
  // input の親要素に position: relative を設定
  const inputWrapper = input.parentElement;
  inputWrapper.style.position = 'relative';
  inputWrapper.appendChild(suggestBox);
  
  // サジェスト更新関数（検索窓と同じロジック）
  async function updateModalSuggestions() {
    const q = input.value.trim();
    suggestBox.innerHTML = '';
    if (!q) { suggestBox.style.display = 'none'; return; }
    
    const wardHits = [];
    if (q === '東') {
      wardHits.push(...Object.keys(TOKYO_WARDS).map(w => `東京都${w}`));
    } else if (q === '東京' || q === '東京都' || '東京都'.startsWith(q) || q.startsWith('東京都')) {
      const suffix = q.replace(/^東京都?/, '');
      wardHits.push(...Object.keys(TOKYO_WARDS).filter(w => !suffix || w.startsWith(suffix)).map(w => `東京都${w}`));
    } else {
      wardHits.push(...Object.keys(TOKYO_WARDS).filter(w => w.startsWith(q)).map(w => `東京都${w}`));
    }
    
    // 区が確定していれば町・丁目候補
    const m = q.replace(/\s+/g, '').match(/^東京都?([^ ]+?区)(.*)$/);
    let finalList = wardHits;
    if (m) {
      const wardName = m[1];
      const after = m[2] || '';
      if (TOKYO_WARDS[wardName]) {
        const cand = await getTownChomeList(wardName);
        const qTown = after;
        const starts = cand.filter(c => c.label.startsWith(qTown));
        const parts = cand.filter(c => !c.label.startsWith(qTown) && c.label.includes(qTown));
        const towns = starts.concat(parts).slice(0, 12);
        if (towns.length) {
          finalList = towns.map(c => `東京都${wardName}${c.label}`);
        }
      }
    }
    
    if (!finalList.length) { suggestBox.style.display = 'none'; return; }
    
    finalList.forEach(h => {
      const li = document.createElement('li');
      li.textContent = h;
      li.style.padding = '6px 8px';
      li.style.cursor = 'pointer';
      li.style.borderRadius = '0.25rem';
      
      li.addEventListener('mouseenter', () => {
        li.style.background = '#f3f4f6';
      });
      li.addEventListener('mouseleave', () => {
        li.style.background = '';
      });
      
      li.addEventListener('click', () => {
        input.value = h.trim();
        input.focus();
        setTimeout(() => updateModalSuggestions(), 0);
        const end = input.value.length;
        try { input.setSelectionRange(end, end); } catch(_) {}
      });
      
      suggestBox.appendChild(li);
    });
    suggestBox.style.display = 'block';
  }
  
  input.addEventListener('input', updateModalSuggestions);
  
  // モーダル外クリックでサジェストを閉じる
  modal.addEventListener('click', (e) => {
    if (!inputWrapper.contains(e.target)) {
      suggestBox.style.display = 'none';
    }
  });
  
  // 入力欄にフォーカス
  setTimeout(() => {
    modal.querySelector('.modal-input').focus();
  }, 100);
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

  // 統一関数を使用
  focusOnPoint(lat, lng, m);
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
      const ok = confirm(
        `${result.label} ✗\n\n` +
        `このアプリではヒットしませんでした。\n\n` +
        `Googleマップでは開ける場合がほとんどです。\n` +
        `ピンは立ちませんので順番は手動で並び替えてください。\n\n` +
        `リストに追加しますか？`
      );
      
      if (!ok) return;
      
      // リストに追加（座標なし）
      addVia(null, null, result.label, 'FAILED');
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
  
  // 初回は0からスタート、2回目以降は+1
  if (packIndex === 0 && !hasShownPack) {
    hasShownPack = true;
  } else {
    packIndex++;
    if (packIndex * packSize >= route.length) packIndex = 0;
  }
  
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

// 一括プレビュー：全選択/全解除
document.getElementById('bulkSelectAll')?.addEventListener('click', () => {
  document.querySelectorAll('.bulk-checkbox').forEach(cb => cb.checked = true);
});

document.getElementById('bulkDeselectAll')?.addEventListener('click', () => {
  document.querySelectorAll('.bulk-checkbox').forEach(cb => cb.checked = false);
});

// 一括プレビュー：チェック削除
document.getElementById('bulkDelete')?.addEventListener('click', () => {
  const checkedIndexes = Array.from(document.querySelectorAll('.bulk-checkbox:checked'))
    .map(cb => parseInt(cb.dataset.idx, 10));
  
  if (!checkedIndexes.length) {
    alert('削除する住所を選択してください');
    return;
  }
  
  const ok = confirm(`${checkedIndexes.length}件の住所を削除しますか？`);
  if (!ok) return;
  
  // データから削除
  bulkPreviewData = bulkPreviewData.filter(item => !checkedIndexes.includes(item.idx));
  
  // カードを削除
  checkedIndexes.forEach(idx => {
    const card = document.querySelector(`.bulk-preview-card[data-idx="${idx}"]`);
    if (card) card.remove();
  });
  
  // 全て削除された場合は入力モードに戻る
  if (!bulkPreviewData.length) {
    document.getElementById('bulkBack').click();
  }
});

// 一括プレビュー：全選択/全解除トグル
document.getElementById('bulkToggleSelect')?.addEventListener('click', (e) => {
  const btn = e.target;
  const checkboxes = document.querySelectorAll('.bulk-checkbox');
  
  // 現在の状態を確認
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  
  if (allChecked) {
    // 全て選択中 → 全解除
    checkboxes.forEach(cb => cb.checked = false);
    btn.textContent = '☐選択';
  } else {
    // 一部または全て未選択 → 全選択
    checkboxes.forEach(cb => cb.checked = true);
    btn.textContent = '☑選択';
  }
});

// 一括プレビュー：新規カード追加
document.getElementById('bulkAddNew')?.addEventListener('click', () => {
  // 新しいインデックスを生成
  const newIdx = bulkPreviewData.length > 0 
    ? Math.max(...bulkPreviewData.map(item => item.idx)) + 1 
    : 0;
  
  // 空の住所データを追加
  const newItem = {
    idx: newIdx,
    label: '',
    status: 'PENDING',
    lat: null,
    lng: null
  };
  
  bulkPreviewData.push(newItem);
  
  // カードを生成
  const previewList = document.getElementById('bulkPreviewList');
  const card = document.createElement('div');
  card.className = 'bulk-preview-card';
  card.dataset.idx = newIdx;
  card.innerHTML = `
    <input type="checkbox" class="bulk-checkbox" checked data-idx="${newIdx}" />
    <span class="bulk-address">（未入力） <span class="status-badge"></span></span>
    <button class="bulk-edit-btn" data-idx="${newIdx}">✏️</button>
  `;
  
  previewList.appendChild(card);
  
  // 編集ボタンは既存のデリゲーションで動作する
});

// 一括プレビュー：入力モードに戻る
document.getElementById('bulkBack')?.addEventListener('click', () => {
  // プレビューを非表示、入力エリアを表示
  document.getElementById('bulkPreview').style.display = 'none';
  document.getElementById('bulkInputArea').style.display = 'block';
  
  // ☐選択ボタンをリセット
  const toggleBtn = document.getElementById('bulkToggleSelect');
  if (toggleBtn) toggleBtn.textContent = '☐選択';
  
  // プログレス表示をクリア
  document.getElementById('bulkProgress').textContent = '';
  
  // ボタン表示を元に戻す
  document.getElementById('extractBtn').style.display = 'inline-block';
  document.getElementById('bulkBack').style.display = 'none';
  document.getElementById('bulkClearInput').style.display = 'inline-block';
  document.getElementById('bulkDelete').style.display = 'none';
});

// 一括入力：Cボタン（入力クリア）
document.getElementById('bulkClearInput')?.addEventListener('click', () => {
  const ok = confirm('テキスト入力を全て削除しますか？');
  if (ok) bulkInput.value = '';
});

// ヘルプアイコンのクリック処理
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('help-icon')) return;
  
  e.stopPropagation(); // 親要素のクリックイベントを防ぐ
  
  const type = e.target.getAttribute('data-help');
  
  const messages = {
    'success':
      '座標がヒットしました。\n\n' +
      '※このアプリで調べられる座標は\n' +
      '丁目の中心点まで\n' +
      '(丁目がない場合は町まで)です。\n\n' +
      '最終的には住所文字列のまま\n' +
      'Googleマップへリンクしますので\n' +
      '文字列をよくご確認ください。',
    'partial': 
      'このアプリでは区の中心点です。\n\n' +
      '町・丁目まで入れると\n' +
      'ピンやルートの精度が上がります。',
    'failed': 
      'このアプリではヒットしませんでした。\n\n' +
      'Googleマップでは開ける場合がほとんどです。\n' +
      'ピンは立ちませんので順番は手動で並び替えてください。'
  };
  
  if (messages[type]) {
    alert(messages[type]);
  }
});