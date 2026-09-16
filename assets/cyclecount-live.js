/* PiMS Cycle Count live data. Uses exported Power BI selections and measures. */
(() => {
  'use strict';
  const root = document.getElementById('tabCycleCount');
  if (!root) return;
  const el = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => v == null ? '—' : Number(v).toLocaleString('en-US');
  const pct = v => v == null ? '—' : (v * 100).toFixed(2) + '%';
  const color = {'Baseline':'#6B7686','High Movement Focus':'#2F80ED','High Value Focus':'#F2C94C','Long Lead Focus':'#F2994A','Service Risk Focus':'#CC0033'};
  const status = document.createElement('p');
  status.id = 'ccLiveStatus'; status.style.cssText = 'color:#bbb;font-size:12px;margin:0 0 16px';
  status.textContent = 'Loading Cycle Count analytics…';
  el('viz-cc-kpis').before(status);
  let data, itemMap, summaryMap, selectionMap, scenarios, targets;
  let scenarioId = 1, target = 40, impactType = 'Common with Baseline';
  const key = (s,t) => `${s}|${t}`;
  const fail = (ok, message) => { if (!ok) throw new Error(message); };
  function normalize(row) {
    return Object.fromEntries(Object.entries(row).map(([k,v]) => [k.replace(/^\[|\]$/g,''),v]));
  }
  function validate(raw) {
    fail(raw.schemaVersion === 1, 'Unsupported Cycle Count schema.');
    fail(Number.isFinite(Date.parse(raw.exportedAtUtc)), 'Invalid export timestamp.');
    const fields = ['summary','overallCurve','scenarioCurves','items','selections','impact','matrix'];
    const d = {exportedAtUtc:raw.exportedAtUtc};
    for (const k of fields) {
      fail(Array.isArray(raw[k]) && raw[k].length > 0, `Missing ${k} rows.`);
      d[k] = raw[k].map(normalize);
    }
    const items = new Map();
    for (const r of d.items) {
      fail(typeof r.item === 'string' && !items.has(r.item), 'Duplicate or invalid item dictionary.');
      items.set(r.item,r);
    }
    const summaries = new Map();
    for (const r of d.summary) {
      const k = key(r.scenarioId,r.coverageTarget);
      fail(!summaries.has(k) && Number.isInteger(r.selectedItems) && r.selectedItems >= 0, 'Invalid scenario summary.');
      summaries.set(k,r);
    }
    const selections = new Map();
    for (const r of d.selections) {
      const k=key(r.scenarioId,r.coverageTarget);
      fail(items.has(r.item) && summaries.has(k), 'Selection references an unknown item or scenario.');
      if (!selections.has(k)) selections.set(k,new Set());
      fail(!selections.get(k).has(r.item), 'Duplicate selected item.');
      selections.get(k).add(r.item);
    }
    const scenarioList = [...new Map(d.summary.map(r=>[r.scenarioId,{id:r.scenarioId,name:r.scenario}])).values()].sort((a,b)=>a.id-b.id);
    const targetList = [...new Set(d.summary.map(r=>r.coverageTarget))].sort((a,b)=>a-b);
    fail(scenarioList.some(s=>s.id===1), 'Baseline scenario is missing.');
    for (const s of scenarioList) for (const t of targetList) {
      const k=key(s.id,t), row=summaries.get(k), set=selections.get(k)||new Set();
      fail(row && row.selectedItems===set.size, 'Selection count does not match Power BI summary.');
      const base=selections.get(key(1,t))||new Set();
      const expected={
        'Common with Baseline':[...set].filter(i=>base.has(i)).length,
        'Added by Scenario':[...set].filter(i=>!base.has(i)).length,
        'Dropped from Baseline':[...base].filter(i=>!set.has(i)).length
      };
      const impact=d.impact.filter(r=>r.scenarioId===s.id&&r.coverageTarget===t);
      fail(impact.length===3 && new Set(impact.map(r=>r.impactType)).size===3 && impact.every(r=>r.itemCount===expected[r.impactType]), 'Impact counts do not match selected sets.');
      fail(d.matrix.some(r=>r.scenarioId===s.id&&r.coverageTarget===t), 'Missing matrix combination.');
    }
    for(const r of [...d.overallCurve,...d.scenarioCurves]) fail(Number.isFinite(r.rank)&&Number.isFinite(r.cumulativeCoverage)&&r.cumulativeCoverage>=0&&r.cumulativeCoverage<=1.000001,'Invalid curve point.');
    for(const s of scenarioList) fail(d.scenarioCurves.some(r=>r.scenarioId===s.id),'Missing scenario curve.');
    for(const r of d.matrix) fail(Number.isInteger(r.itemCount)&&r.itemCount>=0,'Invalid matrix count.');
    return {d,items,summaries,selections,scenarioList,targetList};
  }
  const selected = () => selectionMap.get(key(scenarioId,target)) || new Set();
  function choose(id) { scenarioId=id; render(); }
  function curve(rows, kneeRank, kneeCoverage, label) {
    rows=[...rows].sort((a,b)=>a.rank-b.rank);
    const w=760,h=250,l=48,r=20,t=24,b=38,max=Math.max(...rows.map(x=>x.rank),1);
    const x=n=>l+(n/max)*(w-l-r), y=n=>t+(1-n)*(h-t-b);
    const path=rows.map((p,i)=>`${i?'L':'M'}${x(p.rank)},${y(p.cumulativeCoverage)}`).join(' ');
    const point=rows.find(p=>p.rank===kneeRank);
    const cov=Number.isFinite(kneeCoverage)?kneeCoverage:point?.cumulativeCoverage;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label)}">
      ${[0,.5,1].map(v=>`<line x1="${l}" x2="${w-r}" y1="${y(v)}" y2="${y(v)}" stroke="#333"/><text x="${l-8}" y="${y(v)+4}" fill="#bbb" font-size="11" text-anchor="end">${v*100}%</text>`).join('')}
      <path d="${path}" fill="none" stroke="#2F80ED" stroke-width="3"/>
      ${point&&Number.isFinite(cov)?`<line x1="${x(kneeRank)}" x2="${x(kneeRank)}" y1="${t}" y2="${h-b}" stroke="#ff899f" stroke-dasharray="4 4"/><circle cx="${x(kneeRank)}" cy="${y(cov)}" r="6" fill="#CC0033"><title>Rank ${kneeRank}: ${pct(cov)}</title></circle>`:''}
      <text x="${l}" y="${h-8}" fill="#bbb" font-size="11">Rank 0</text><text x="${w-r}" y="${h-8}" text-anchor="end" fill="#bbb" font-size="11">Rank ${max}</text>
      ${rows.map(p=>`<circle cx="${x(p.rank)}" cy="${y(p.cumulativeCoverage)}" r="5" fill="transparent"><title>Rank ${p.rank}: ${pct(p.cumulativeCoverage)}</title></circle>`).join('')}
    </svg>`;
  }
  function renderDeck() {
    const term=el('ccDeckSearch').value.trim().toLowerCase();
    const rows=[...selected()].map(i=>itemMap.get(i)).sort((a,b)=>a.priorityRank-b.priorityRank).filter(i=>(i.item+' '+i.description).toLowerCase().includes(term));
    el('ccDeckWrap').innerHTML=rows.map(i=>`<div class="cc-deck-card"><span class="cc-deck-rank">${fmt(i.priorityRank)}</span><span class="cc-deck-code">${esc(i.item)}</span><p class="cc-deck-desc">${esc(i.description)}</p><p class="cc-deck-usage">Main driver: ${esc(i.mainDriver??'—')} · Priority index: ${fmt(i.priorityIndex)}</p></div>`).join('')||'<p>No matching selected items.</p>';
    el('ccDeckCount').textContent=`Showing ${rows.length} of ${selected().size} selected items`;
  }
  function renderImpact() {
    const counts=data.impact.filter(r=>r.scenarioId===scenarioId&&r.coverageTarget===target).sort((a,b)=>a.sortOrder-b.sortOrder);
    el('ccShiftWrap').innerHTML=`<div class="cc-shift-row">${counts.map(r=>`<button type="button" data-impact="${esc(r.impactType)}" class="cc-shift-tile" style="background:#191919;color:#eee;text-align:left;cursor:pointer;border:1px solid ${r.impactType===impactType?'#2F80ED':'#444'}"><p class="cc-shift-count">${fmt(r.itemCount)}</p><p class="cc-shift-label">${esc(r.impactType)}</p></button>`).join('')}</div><div id="ccImpactItems" style="max-height:260px;overflow:auto;margin-top:16px"></div>`;
    const base=selectionMap.get(key(1,target))||new Set(), current=selected();
    const ids=impactType==='Dropped from Baseline'?[...base].filter(i=>!current.has(i)):[...current].filter(i=>impactType==='Common with Baseline'?base.has(i):!base.has(i));
    el('ccImpactItems').innerHTML=`<p>${esc(impactType)}: ${ids.length} items</p>`+ids.map(i=>itemMap.get(i)).sort((a,b)=>a.priorityRank-b.priorityRank).map(i=>`<div style="padding:7px 0;border-bottom:1px solid #333">${esc(i.item)} — ${esc(i.description)}</div>`).join('');
  }
  function renderMatrix() {
    const rows=data.matrix.filter(r=>r.scenarioId===scenarioId&&r.coverageTarget===target);
    const actions=['Increase Max','Maintain Max','Reduce Max','Review Required'];
    const statuses=['Not Selected','Selected'];
    fail(rows.every(r=>actions.includes(r.minMaxAction)&&statuses.includes(r.selectionStatus)), 'Unexpected matrix category.');
    const count=(s,a)=>rows.filter(r=>(!s||r.selectionStatus===s)&&(!a||r.minMaxAction===a)).reduce((n,r)=>n+r.itemCount,0);
    const cell=v=>`<td style="padding:12px;text-align:right;border-bottom:1px solid #333">${fmt(v)}</td>`;
    el('ccRecWrap').innerHTML=`<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;color:#eee"><thead><tr><th style="text-align:left;padding:12px">Selection status</th>${[...actions,'Total'].map(a=>`<th style="padding:12px;text-align:right">${a}</th>`).join('')}</tr></thead><tbody>${[...statuses,'Total'].map(s=>`<tr><th style="text-align:left;padding:12px">${s}</th>${actions.map(a=>cell(count(s==='Total'?null:s,a))).join('')}${cell(count(s==='Total'?null:s,null))}</tr>`).join('')}</tbody></table></div>`;
    el('ccRecSummary').textContent='Stock maximum changes for items in the Min–Max recommendation dataset. Review Required means a current or recommended maximum is missing.';
    el('ccRecCount').textContent=`${count(null,null)} items in the Min–Max comparison; the cycle-count ranking contains ${itemMap.size} items.`;
  }
  function render() {
    const row=summaryMap.get(key(scenarioId,target));
    el('ccKpiTotal').textContent=fmt(itemMap.size);el('ccKpiSelected').textContent=fmt(row.selectedItems);
    el('ccKpiRate').textContent=(row.selectedItems/itemMap.size*100).toFixed(1)+'%';
    el('ccKpiThreshold').textContent=row.exposureText??'—';el('ccKpiThresholdLbl').textContent=row.exposureTitle;
    el('ccScenarioRow').querySelectorAll('[data-scenario]').forEach(n=>n.classList.toggle('active',n.dataset.scenario===row.scenario));
    el('ccDialPct').textContent=target+'%';el('ccSliderReadout').textContent=`${row.selectedItems} of ${itemMap.size} items selected`;
    const c=2*Math.PI*80, fraction=target/100;
    el('ccDialSvg').innerHTML=`<circle cx="100" cy="100" r="80" fill="none" stroke="#333" stroke-width="14"/><circle cx="100" cy="100" r="80" fill="none" stroke="${color[row.scenario]||'#2F80ED'}" stroke-width="14" stroke-dasharray="${c}" stroke-dashoffset="${c*(1-fraction)}" transform="rotate(-90 100 100)"/>`;
    el('ccThreshHeroVal').textContent=row.exposureText??'—';el('ccThreshHeroScenario').textContent=row.exposureTitle;
    el('ccThreshHeroDot').style.background=color[row.scenario]||'#2F80ED';
    el('ccThreshCaption').textContent=`${fmt(row.mandatoryItems)} mandatory items. Exposure is exported directly from Power BI.`;
    el('ccThresholdStrip').innerHTML=scenarios.map(s=>{const r=summaryMap.get(key(s.id,target));return `<button type="button" class="cc-thresh-row ${s.id===scenarioId?'active':''}" data-id="${s.id}" style="width:100%;background:transparent;color:inherit;text-align:left;cursor:pointer"><span class="name">${esc(s.name)}</span><span class="val">${esc(r.exposureText??'—')}</span></button>`}).join('');
    const knee=data.overallCurve.find(r=>r.isKneePoint===1||r.isKneePoint===true)||data.overallCurve[0];
    el('ccCurveWrap').innerHTML=curve(data.overallCurve,knee.kneeRank,knee.kneeCoverage,'Overall priority exposure curve');
    el('ccOverallCaption').textContent=`Overall priority knee: rank ${knee.kneeRank}, covering ${pct(knee.kneeCoverage)}. Independent of scenario and coverage target.`;
    el('ccScenarioCurveWrap').innerHTML=curve(data.scenarioCurves.filter(r=>r.scenarioId===scenarioId),row.kneeRank,row.kneeCoverage,'Scenario factor coverage curve');
    el('ccScenarioCurveCaption').textContent=`${row.scenario}: marker at rank ${row.kneeRank}, covering ${pct(row.kneeCoverage)} of its factor exposure. ${scenarioId===1?'Baseline uses the stored priority knee.':'The marker is the stored mandatory-item cutoff.'}`;
    renderImpact();renderDeck();renderMatrix();
  }
  async function load() {
    try {
      const response=await fetch(new URL('./data/cyclecount.json',document.baseURI),{cache:'no-store'});
      fail(response.ok,`Cycle Count data request returned ${response.status}.`);
      const checked=validate(await response.json());
      ({d:data,items:itemMap,summaries:summaryMap,selections:selectionMap,scenarioList:scenarios,targetList:targets}=checked);
      target=targets.includes(40)?40:targets[0];
      el('ccSlider').min=0;el('ccSlider').max=targets.length-1;el('ccSlider').value=targets.indexOf(target);
      el('ccScenarioRow').innerHTML=scenarios.map(s=>`<button type="button" class="cc-chip" data-scenario="${esc(s.name)}" data-id="${s.id}" style="--chip-color:${color[s.name]||'#2F80ED'}">${esc(s.name)}</button>`).join('');
      el('ccScenarioRow').addEventListener('click',e=>{const n=e.target.closest('[data-id]');if(n)choose(Number(n.dataset.id));});
      el('ccSlider').addEventListener('input',e=>{target=targets[Number(e.target.value)];render();});
      el('ccDeckSearch').addEventListener('input',renderDeck);
      el('ccThresholdStrip').addEventListener('click',e=>{const n=e.target.closest('[data-id]');if(n)choose(Number(n.dataset.id));});
      el('ccShiftWrap').addEventListener('click',e=>{const n=e.target.closest('[data-impact]');if(n){impactType=n.dataset.impact;renderImpact();}});
      render();
      const exported=new Date(data.exportedAtUtc),age=Date.now()-exported.getTime();
      const readable=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'medium',timeZone:'America/New_York'}).format(exported);
      status.textContent=`Website data refreshed ${readable} ET`+(age>8*3600000?' — update is older than expected.':'');
      status.title=`Power BI export timestamp: ${exported.toISOString()}`;
    } catch(error) {
      status.textContent='Cycle Count analytics could not be loaded. Refresh the page; if this continues, check the browser console.';
      console.error('Cycle Count update failed:',error);
    }
  }
  load();
})();
