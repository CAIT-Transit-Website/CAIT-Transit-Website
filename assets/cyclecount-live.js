/* PiMS Cycle Count live data — preserves the original Cycle Count page layout. */
(() => {
  'use strict';
  const root = document.getElementById('tabCycleCount');
  if (!root) return;
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value == null ? '—' : Number(value).toLocaleString('en-US');
  const percent = value => value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
  const scenarioColors = {'Baseline':'#6B7686','High Movement Focus':'#2F80ED','High Value Focus':'#F2C94C','Long Lead Focus':'#F2994A','Service Risk Focus':'#CC0033'};
  const thresholdCaptions = {
    'Baseline':'Baseline carries no mandatory exposure — it ranks every item purely by priority.',
    'High Movement Focus':'This scenario prioritizes items around mandatory annual movement.',
    'High Value Focus':'This scenario prioritizes items around mandatory inventory value.',
    'Long Lead Focus':'This scenario prioritizes items around mandatory lead-time exposure.',
    'Service Risk Focus':'This scenario prioritizes items around mandatory service-risk coverage.'
  };
  const status = document.createElement('p');
  status.id = 'ccLiveStatus';
  status.setAttribute('role','status');
  status.style.cssText = 'color:#bbb;font-size:12px;margin:0 0 16px';
  status.textContent = 'Loading Cycle Count analytics; existing figures are a saved snapshot.';
  el('viz-cc-kpis').before(status);

  let data, itemMap, summaryMap, selectionMap, scenarios, targets;
  const state = {scenarioId:1, target:40, recSort:'rank', impact:null};
  const deckTitle = el('viz-cc-deck').querySelector('.dcard-title');
  const deckCaption = el('viz-cc-deck').querySelector('.dcard-cap');
  const originalDeckTitle = deckTitle.textContent;
  const originalDeckCaption = deckCaption.textContent;
  const mapKey = (scenarioId,target) => `${scenarioId}|${target}`;
  const check = (condition,message) => { if (!condition) throw new Error(message); };
  const normalize = row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/^\[|\]$/g,''),value]));

  function validate(raw) {
    check(raw && raw.schemaVersion === 1, 'Unsupported Cycle Count schema.');
    check(Number.isFinite(Date.parse(raw.exportedAtUtc)), 'Invalid Cycle Count export timestamp.');
    const fields = ['summary','overallCurve','scenarioCurves','items','selections','impact','matrix'];
    const normalized = {exportedAtUtc:raw.exportedAtUtc};
    for (const field of fields) {
      check(Array.isArray(raw[field]) && raw[field].length > 0, `Missing ${field} rows.`);
      normalized[field] = raw[field].map(normalize);
    }
    const items = new Map();
    for (const row of normalized.items) {
      check(typeof row.item === 'string' && !items.has(row.item), 'Duplicate or invalid Cycle Count item.');
      items.set(row.item,row);
    }
    const summaries = new Map(normalized.summary.map(row => [mapKey(row.scenarioId,row.coverageTarget),row]));
    const selections = new Map();
    for (const row of normalized.selections) {
      const key = mapKey(row.scenarioId,row.coverageTarget);
      check(items.has(row.item) && summaries.has(key), 'A selection references an unknown item or scenario.');
      if (!selections.has(key)) selections.set(key,new Set());
      selections.get(key).add(row.item);
    }
    const scenarioList = [...new Map(normalized.summary.map(row => [row.scenarioId,{id:row.scenarioId,name:row.scenario}])).values()].sort((a,b) => a.id-b.id);
    const targetList = [...new Set(normalized.summary.map(row => row.coverageTarget))].sort((a,b) => a-b);
    for (const scenario of scenarioList) for (const target of targetList) {
      const row = summaries.get(mapKey(scenario.id,target));
      const selected = selections.get(mapKey(scenario.id,target)) || new Set();
      check(row && row.selectedItems === selected.size, 'Selected-item count differs from the Power BI summary.');
    }
    return {normalized,items,summaries,selections,scenarioList,targetList};
  }

  const currentScenario = () => scenarios.find(s => s.id === state.scenarioId);
  const currentSummary = () => summaryMap.get(mapKey(state.scenarioId,state.target));
  const selectedIds = () => selectionMap.get(mapKey(state.scenarioId,state.target)) || new Set();
  const selectedItems = () => [...selectedIds()].map(id => itemMap.get(id)).filter(Boolean);
  function deckItems() {
    const current = selectedIds();
    const baseline = selectionMap.get(mapKey(1,state.target)) || new Set();
    let ids = [...current];
    if (state.impact === 'Common with Baseline') ids = ids.filter(id => baseline.has(id));
    if (state.impact === 'Added by Scenario') ids = ids.filter(id => !baseline.has(id));
    if (state.impact === 'Dropped from Baseline') ids = [...baseline].filter(id => !current.has(id));
    return ids.map(id => itemMap.get(id)).filter(Boolean);
  }

  function renderDial() {
    const circumference = 2 * Math.PI * 80;
    const fraction = targets.length > 1 ? targets.indexOf(state.target) / (targets.length - 1) : 1;
    const color = scenarioColors[currentScenario().name] || '#CC0033';
    el('ccDialSvg').innerHTML = `<circle cx="100" cy="100" r="80" fill="none" stroke="#2c2c2c" stroke-width="14"/><circle cx="100" cy="100" r="80" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1-fraction)}" transform="rotate(-90 100 100)"/>`;
    el('ccDialPct').textContent = `${state.target}%`;
    el('ccSliderReadout').textContent = `${selectedIds().size} of ${itemMap.size} items selected`;
  }

  function renderKpis() {
    const row = currentSummary();
    el('ccKpiTotal').textContent = number(itemMap.size);
    el('ccKpiSelected').textContent = number(row.selectedItems);
    el('ccKpiRate').textContent = `${(row.selectedItems / itemMap.size * 100).toFixed(1)}%`;
    el('ccKpiThreshold').textContent = row.exposureText ?? '—';
    el('ccKpiThresholdLbl').textContent = row.exposureTitle;
  }

  function renderThreshold() {
    const scenario = currentScenario();
    const row = currentSummary();
    const color = scenarioColors[scenario.name] || '#CC0033';
    el('ccThreshHeroDot').style.background = color;
    el('ccThreshHeroVal').textContent = row.exposureText ?? '—';
    el('ccThreshHeroVal').style.color = row.exposureText === '—' ? '#d8d8d8' : color;
    el('ccThreshHeroScenario').textContent = row.exposureTitle;
    el('ccThreshCaption').textContent = thresholdCaptions[scenario.name] || '';
    el('ccThresholdStrip').innerHTML = scenarios.map(scenarioOption => {
      const option = summaryMap.get(mapKey(scenarioOption.id,state.target));
      const active = scenarioOption.id === state.scenarioId;
      return `<div class="cc-thresh-row ${active?'active':''}" data-id="${scenarioOption.id}" style="${active?`border-left-color:${scenarioColors[scenarioOption.name]||'#CC0033'}`:''}"><span class="cc-thresh-dot" style="background:${scenarioColors[scenarioOption.name]||'#CC0033'}"></span><span class="name">${esc(scenarioOption.name)}</span><span class="val">${esc(option.exposureText ?? '—')}</span></div>`;
    }).join('');
  }

  function renderCurve() {
    const rows = [...data.overallCurve].sort((a,b) => a.rank-b.rank);
    const width=760,height=240,left=40,right=20,top=16,bottom=30;
    const plotWidth=width-left-right, plotHeight=height-top-bottom;
    const maxRank=Math.max(...rows.map(row => row.rank));
    const x=rank => left + (rank-1)/(Math.max(maxRank-1,1))*plotWidth;
    const y=coverage => top + (1-coverage)*plotHeight;
    const path=rows.map((row,index) => `${index?'L':'M'} ${x(row.rank)} ${y(row.cumulativeCoverage)}`).join(' ');
    const area=`${path} L ${x(maxRank)} ${top+plotHeight} L ${x(1)} ${top+plotHeight} Z`;
    const selectedRanks=selectedItems().map(item => item.priorityRank).filter(Number.isFinite);
    const cutoffRank=selectedRanks.length ? Math.max(...selectedRanks) : null;
    const cutoff=rows.find(row => row.rank===cutoffRank);
    const knee=rows.find(row => row.isKneePoint===1 || row.isKneePoint===true) || rows.find(row => row.rank===row.kneeRank);
    el('ccKneeRankLbl').textContent = knee?.kneeRank ?? '—';
    el('ccCurveWrap').innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="240"><defs><linearGradient id="ccCurveGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#CC0033" stop-opacity="0.45"/><stop offset="100%" stop-color="#CC0033" stop-opacity="0"/></linearGradient></defs><line x1="${left}" y1="${top}" x2="${left}" y2="${top+plotHeight}" stroke="#2c2c2c"/><line x1="${left}" y1="${top+plotHeight}" x2="${left+plotWidth}" y2="${top+plotHeight}" stroke="#2c2c2c"/><text x="${left-8}" y="${top+4}" text-anchor="end" font-size="10" fill="#9A9A9A">100%</text><text x="${left-8}" y="${top+plotHeight+4}" text-anchor="end" font-size="10" fill="#9A9A9A">0%</text><text x="${left}" y="${height-6}" font-size="10" fill="#9A9A9A">Rank 1</text><text x="${left+plotWidth}" y="${height-6}" text-anchor="end" font-size="10" fill="#9A9A9A">Rank ${maxRank}</text><path d="${area}" fill="url(#ccCurveGrad)"/><path d="${path}" fill="none" stroke="#CC0033" stroke-width="2.5"/>${cutoff?`<line x1="${x(cutoff.rank)}" y1="${y(cutoff.cumulativeCoverage)}" x2="${x(cutoff.rank)}" y2="${top+plotHeight}" stroke="#CC0033" stroke-dasharray="3 3"/><circle cx="${x(cutoff.rank)}" cy="${y(cutoff.cumulativeCoverage)}" r="6" fill="#fff" stroke="#CC0033" stroke-width="3"><title>Current selection cutoff: rank ${cutoff.rank}, ${percent(cutoff.cumulativeCoverage)}</title></circle>`:''}${knee?`<text x="${x(knee.rank)}" y="${y(knee.cumulativeCoverage)-6}" text-anchor="middle" font-size="26"><title>Model knee: rank ${knee.rank}, ${percent(knee.cumulativeCoverage)}</title>📍</text>`:''}</svg>`;
  }

  function renderShift() {
    const rows=data.impact.filter(row => row.scenarioId===state.scenarioId && row.coverageTarget===state.target).sort((a,b) => a.sortOrder-b.sortOrder);
    if (state.scenarioId===1) {
      el('ccShiftWrap').innerHTML='<p style="color:var(--dark-muted);font-size:12.5px;padding:8px 2px">Baseline is the reference scenario — switch to another scenario above to see how its selection differs.</p>';
      return;
    }
    const meta={
      'Common with Baseline':{icon:'=',color:'#d8d8d8',background:'#2c2c2c',label:'Common with Baseline'},
      'Added by Scenario':{icon:'+',color:'#6FCF97',background:'rgba(39,174,96,0.18)',label:'Added by this scenario'},
      'Dropped from Baseline':{icon:'–',color:'#ff6b81',background:'rgba(204,0,51,0.18)',label:'Dropped from Baseline'}
    };
    el('ccShiftWrap').innerHTML=`<div class="cc-shift-row">${rows.map(row => {const m=meta[row.impactType];return `<div class="cc-shift-tile" role="button" tabindex="0" data-impact="${esc(row.impactType)}" aria-pressed="${state.impact===row.impactType}" title="Filter item deck; click again to show all selected items" style="cursor:pointer;${state.impact===row.impactType?`outline:2px solid ${m.color};outline-offset:-2px;`:''}"><div class="cc-shift-icon" style="background:${m.background};color:${m.color}">${m.icon}</div><p class="cc-shift-count" style="color:${m.color}">${number(row.itemCount)}</p><p class="cc-shift-label">${m.label}</p></div>`}).join('')}</div>`;
  }

  function renderDeck() {
    const term=el('ccDeckSearch').value.trim().toLowerCase();
    const source=deckItems();
    const rows=source.sort((a,b) => a.priorityRank-b.priorityRank).filter(item => `${item.item} ${item.description}`.toLowerCase().includes(term));
    deckTitle.textContent=state.impact?`Items — ${state.impact}`:originalDeckTitle;
    deckCaption.textContent=state.impact?'Showing the category selected above. Click that category again to show all selected items.':originalDeckCaption;
    el('ccDeckWrap').innerHTML=rows.map(item => `<div class="cc-deck-card"><span class="cc-deck-rank">${number(item.priorityRank)}</span><span class="cc-deck-code">${esc(item.item)}</span><p class="cc-deck-desc">${esc(item.description)}</p><p class="cc-deck-usage">${item.annualUsage!=null?`Annual usage: ${number(item.annualUsage)}`:'Annual usage: —'}</p></div>`).join('') || '<p style="color:var(--dark-muted);font-size:12.5px">No selected items match this search.</p>';
    el('ccDeckCount').textContent=state.impact?`Showing ${rows.length} of ${source.length} items — ${state.impact}`:`Showing ${rows.length} of ${selectedIds().size} selected items`;
    if (!rows.length) el('ccDeckWrap').innerHTML='<p style="color:var(--dark-muted);font-size:12.5px">No items match this category and search.</p>';
  }

  function renderRecommendations() {
    let rows=selectedItems().map(item => {
      const complete=[item.currentMin,item.currentMax,item.recommendedMin,item.recommendedMax].every(value => value!=null && Number.isFinite(Number(value)));
      if (!complete) return {item,kind:'review',pct:null};
      const currentSpan=Number(item.currentMax)-Number(item.currentMin);
      const recommendedSpan=Number(item.recommendedMax)-Number(item.recommendedMin);
      const change=currentSpan>0?(recommendedSpan-currentSpan)/currentSpan*100:0;
      return {item,kind:Math.abs(change)<.5?'same':change<0?'narrower':'wider',pct:change};
    });
    rows.sort(state.recSort==='code'?(a,b)=>a.item.item.localeCompare(b.item.item):(a,b)=>a.item.priorityRank-b.item.priorityRank);
    const counts={narrower:0,wider:0,same:0,review:0}; rows.forEach(row=>counts[row.kind]++);
    el('ccRecSummary').innerHTML=`<span class="cc-rec-summary-icon">📊</span><span><strong>${counts.narrower}</strong> tighter, <strong>${counts.wider}</strong> wider, <strong>${counts.same}</strong> unchanged, and <strong>${counts.review}</strong> requiring review.</span>`;
    el('ccRecWrap').innerHTML=rows.map(({item,kind,pct}) => {
      const complete=kind!=='review';
      const maximum=complete?Math.max(Number(item.currentMax),Number(item.recommendedMax),1):1;
      const currentLeft=complete?Number(item.currentMin)/maximum*100:0;
      const currentWidth=complete?Math.max((Number(item.currentMax)-Number(item.currentMin))/maximum*100,1):0;
      const recommendedLeft=complete?Number(item.recommendedMin)/maximum*100:0;
      const recommendedWidth=complete?Math.max((Number(item.recommendedMax)-Number(item.recommendedMin))/maximum*100,1):0;
      const badge=kind==='review'?'Review required':kind==='same'?'No change':kind==='narrower'?`${Math.abs(pct).toFixed(0)}% tighter`:`+${pct.toFixed(0)}% wider`;
      return `<div class="cc-rec-card"><div class="cc-rec-card-top"><span class="cc-rec-code">${esc(item.item)}</span><span class="cc-rec-desc">${esc(item.description)}</span><span class="cc-rec-badge ${kind}">${badge}</span></div><div class="cc-rec-bar-wrap"><div class="cc-rec-bar-track"></div>${complete?`<div class="cc-rec-bar-seg" style="left:${currentLeft}%;width:${currentWidth}%"></div>`:''}<div class="cc-rec-bar-track rec-track"></div>${complete?`<div class="cc-rec-bar-seg rec ${kind}" style="left:${recommendedLeft}%;width:${recommendedWidth}%"></div>`:''}</div><div class="cc-rec-bar-labels"><span>Current: ${complete?`${number(item.currentMin)}–${number(item.currentMax)}`:'—'}</span><span>Recommended: ${complete?`${number(item.recommendedMin)}–${number(item.recommendedMax)}`:'—'}</span></div></div>`;
    }).join('') || '<p style="color:var(--dark-muted);font-size:12.5px">No items selected at this coverage target.</p>';
    el('ccRecCount').textContent=`Showing ${rows.length} of ${selectedIds().size} selected items`;
  }

  function render() {
    document.querySelectorAll('#ccScenarioRow .cc-chip').forEach(chip => chip.classList.toggle('active',Number(chip.dataset.id)===state.scenarioId));
    renderKpis(); renderDial(); renderThreshold(); renderCurve(); renderShift(); renderDeck(); renderRecommendations();
  }

  async function load() {
    try {
      const response=await fetch(new URL('./data/cyclecount.json',document.baseURI),{cache:'no-store'});
      check(response.ok,`Cycle Count data request returned ${response.status}.`);
      const checked=validate(await response.json());
      ({normalized:data,items:itemMap,summaries:summaryMap,selections:selectionMap,scenarioList:scenarios,targetList:targets}=checked);
      state.target=targets.includes(40)?40:targets[0];
      el('ccSlider').min=0; el('ccSlider').max=targets.length-1; el('ccSlider').value=targets.indexOf(state.target);
      el('ccScenarioRow').innerHTML=scenarios.map(scenario => `<div class="cc-chip ${scenario.id===state.scenarioId?'active':''}" data-id="${scenario.id}" data-scenario="${esc(scenario.name)}" style="--chip-color:${scenarioColors[scenario.name]||'#6B7686'}">${esc(scenario.name)}</div>`).join('');
      el('ccScenarioRow').addEventListener('click',event => {const chip=event.target.closest('[data-id]');if(chip){state.impact=null;state.scenarioId=Number(chip.dataset.id);render();}});
      el('ccThresholdStrip').addEventListener('click',event => {const row=event.target.closest('[data-id]');if(row){state.impact=null;state.scenarioId=Number(row.dataset.id);render();}});
      el('ccSlider').addEventListener('input',event => {state.impact=null;state.target=targets[Number(event.target.value)];render();});
      const filterDeck = event => {
        const tile=event.target.closest('[data-impact]');
        if (!tile) return;
        if (event.type==='keydown' && !['Enter',' '].includes(event.key)) return;
        event.preventDefault();
        const type=tile.dataset.impact;
        state.impact=state.impact===type?null:type;
        el('ccDeckSearch').value='';
        renderShift();renderDeck();
        const replacement=[...el('ccShiftWrap').querySelectorAll('[data-impact]')].find(node=>node.dataset.impact===type);
        replacement?.focus({preventScroll:true});
      };
      el('ccShiftWrap').addEventListener('click',filterDeck);
      el('ccShiftWrap').addEventListener('keydown',filterDeck);
      el('ccDeckSearch').addEventListener('input',renderDeck);
      el('ccRecSortRow').addEventListener('click',event => {const button=event.target.closest('[data-sort]');if(!button)return;document.querySelectorAll('#ccRecSortRow .toggle-btn').forEach(node=>node.classList.remove('active'));button.classList.add('active');state.recSort=button.dataset.sort;renderRecommendations();});
      render();
      const exported=new Date(data.exportedAtUtc);
      const age=Date.now()-exported.getTime();
      const readable=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'medium',timeZone:'America/New_York'}).format(exported);
      status.textContent=`Website data refreshed ${readable} ET`+`${age>8*3600000?' — update is older than expected.':''}`;
      status.title=`Power BI export timestamp: ${exported.toISOString()}`;
    } catch(error) {
      status.textContent='Cycle Count analytics could not be loaded. Displayed figures are a saved snapshot; do not treat them as a fresh update.';
      console.error('Cycle Count update failed:',error);
    }
  }
  load();
})();
