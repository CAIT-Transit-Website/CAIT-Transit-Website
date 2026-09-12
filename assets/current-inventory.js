/* Current Inventory Status only. Other dashboard modules keep their own data. */
(() => {
    'use strict';
    const status = document.getElementById('inventory-sync-status');
    const esc = value => String(value ?? '—').replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = value => value == null ? '—' : value.toLocaleString('en-US', {maximumFractionDigits: 2});
    const compact = value => value == null ? '—' : new Intl.NumberFormat('en-US', {
        notation: 'compact', maximumFractionDigits: 1}).format(value);
    const label = value => value || 'Unclassified';
    const weight = row => row.recordCount;
    let current;

    function verify(data) {
        for (const key of ['totalPoQty','totalOnHand','totalInventoryValue'])
            if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) throw Error(`Invalid ${key}`);
        if (!Number.isFinite(Date.parse(data.exportedAtUtc))) throw Error('Invalid timestamp');
        for (const key of ['items','exposure']) if (!Array.isArray(data[key])) throw Error(`Missing ${key}`);
        for (const [group, fields] of [['movement',['active','slow','obsolete']], ['service',['risk','covered']]])
            for (const field of fields) if (!Number.isInteger(data[group]?.[field]) || data[group][field] < 0)
                throw Error(`Missing or invalid ${group}.${field}`);
        for (const row of data.items) {
            if (!Number.isInteger(row.recordCount) || row.recordCount < 0) throw Error('Invalid record count');
            for (const key of ['item','exposureItem','priority','poRisk','storage','desc','recStorage'])
                if (row[key] != null && typeof row[key] !== 'string') throw Error(`Invalid ${key}`);
            for (const key of ['onHand','usage','leadTime','ratio'])
                if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) throw Error(`Invalid ${key}`);
        }
        for (const row of data.exposure) {
            if (row.item != null && typeof row.item !== 'string') throw Error('Invalid exposure item');
            if (row.value != null && (typeof row.value !== 'number' || !Number.isFinite(row.value))) throw Error('Invalid exposure');
        }
    }

    function gauges() {
        const m = current.movement, total = m.active + m.slow + m.obsolete;
        const pct = n => total ? n / total * 100 : 0;
        const svg = document.getElementById('gaugeSvg');
        const legend = document.getElementById('lgActive').parentElement.parentElement;
        legend.innerHTML = [
            ['Active',m.active,'#27AE60','lgActive'],
            ['Slow moving',m.slow,'#CC0033','lgSlow'],
            ...(m.obsolete > 0 ? [['Obsolete',m.obsolete,'#F2C94C','lgObsolete']] : [])
        ].map(([name,n,color,id]) => `<div class="legend-row"><span class="legend-dot" style="background:${color}"></span>${name} — <strong id="${id}" title="${n} category-level distinct items">${total ? pct(n).toFixed(2)+'%' : '—'}</strong></div>`).join('');
        if (!total) svg.innerHTML = '<text x="100" y="65" text-anchor="middle" fill="#bbb">No data</text>';
        else {
            drawGauge('gaugeSvg',pct(m.active),'#27AE60','#CC0033','#F2F2F2');
            if (m.obsolete > 0) {
                const path = document.createElementNS('http://www.w3.org/2000/svg','path');
                for (const [key,value] of Object.entries({d:'M 20 100 A 80 80 0 0 1 180 100',fill:'none',stroke:'#F2C94C','stroke-width':'16','stroke-linecap':'butt',pathLength:'100','stroke-dasharray':`${pct(m.obsolete)} 100`,'stroke-dashoffset':`${-(pct(m.active)+pct(m.slow))}`})) path.setAttribute(key,value);
                svg.insertBefore(path,svg.querySelector('line[stroke="#F2F2F2"]'));
            }
        }
        svg.setAttribute('role','img');
        svg.setAttribute('aria-label',`Active ${m.active}, slow moving ${m.slow}, obsolete ${m.obsolete}`);
        const s = current.service, count = s.risk + s.covered;
        if (count) drawGauge('svcSvg',s.risk/count*100,'#CC0033','#27AE60','#0A0A0A');
        else document.getElementById('svcSvg').innerHTML = '';
        document.getElementById('svcNum').textContent = count ? (s.risk/count*100).toFixed(2)+'%' : '—';
        const legends = document.querySelectorAll('#viz-service .legend-row strong');
        legends[0].textContent = `${s.risk.toLocaleString()} items`;
        legends[1].textContent = `${s.covered.toLocaleString()} items`;
        document.querySelector('#viz-movement .dcard-cap').textContent = m.obsolete > 0
            ? 'Active, slow-moving, and obsolete share of tracked inventory.'
            : 'Active vs. slow-moving share of tracked inventory.';
    }

    function installRenderers() {
        getFilteredItems = function () {
            if (globalFilter.selectedItem !== null) return items.filter(i => (i.exposureItem ?? '') === globalFilter.selectedItem);
            const term = globalFilter.searchTerm.trim().toLowerCase();
            return term ? items.filter(i => [i.item,i.desc,i.priority].join(' ').toLowerCase().includes(term)) : items;
        };
        renderHeatmap = function () {
            const filtered = getFilteredItems();
            const priorities = [...new Set([...HEATMAP_PRIORITIES,...items.map(i=>label(i.priority))])];
            const risks = [...new Set([...HEATMAP_RISKS,...items.map(i=>label(i.poRisk))])];
            const cells = Object.fromEntries(priorities.map(p=>[p,Object.fromEntries(risks.map(r=>[r,0]))]));
            filtered.forEach(i=>cells[label(i.priority)][label(i.poRisk)]+=weight(i));
            const cols = Object.fromEntries(risks.map(r=>[r,priorities.reduce((s,p)=>s+cells[p][r],0)]));
            const sum = p => risks.reduce((s,r)=>s+cells[p][r],0);
            const background = (r,n) => RISK_BASE_COLOR[r] ? heatColor(r,n,Math.max(1,...priorities.map(p=>cells[p][r]))) : '#333';
            document.getElementById('heatmapWrap').innerHTML = `<table class="crosstab-table"><thead><tr><th>Slotting Priority</th>${risks.map(r=>`<th>${esc(r)}</th>`).join('')}<th>Total</th></tr></thead><tbody>${priorities.map(p=>`<tr><td>${esc(p)}</td>${risks.map(r=>`<td style="background:${background(r,cells[p][r])};color:#fff">${cells[p][r] || '—'}</td>`).join('')}<td><strong>${sum(p)}</strong></td></tr>`).join('')}<tr class="crosstab-total-row"><td>Total</td>${risks.map(r=>`<td>${cols[r]}</td>`).join('')}<td><strong>${filtered.reduce((s,i)=>s+weight(i),0)}</strong></td></tr></tbody></table>`;
        };
        renderStorageBars = function () {
            const counts = new Map();
            getFilteredItems().filter(i=>i.priority===activeStorageTab).forEach(i=>counts.set(label(i.storage),(counts.get(label(i.storage))||0)+weight(i)));
            const entries = [...counts].sort((a,b)=>b[1]-a[1]);
            const max = Math.max(1,...entries.map(e=>e[1]));
            const color = {'High Priority':'#CC0033','Medium Priority':'#F2C94C','Low Priority':'#27AE60'}[activeStorageTab];
            document.getElementById('storageBars').innerHTML = entries.length ? entries.map(([name,n])=>`<div class="storage-bar-row"><span class="label">${esc(name)}</span><div class="storage-bar-track"><div class="storage-bar-fill" style="width:${n/max*100}%;background:${color}"></div></div><span class="n">${n}</span></div>`).join('') : '<p style="color:#aaa">No matching items in this tier.</p>';
        };
        renderItemList = function () {
            const p=document.getElementById('fPriority').value,s=document.getElementById('fStorage').value,r=document.getElementById('fRisk').value;
            const filtered=getFilteredItems().filter(i=>(!p||label(i.priority)===p)&&(!s||label(i.storage)===s)&&(!r||label(i.poRisk)===r));
            document.getElementById('itemList').innerHTML=filtered.map(i=>{
                const rc=riskColors[i.poRisk]||{bg:'#232323',text:'#aaa',border:'#444'},pc=priorityColors[i.priority]||'#777';
                return `<div class="item-row" style="border-left-color:${rc.border}"><div class="item-row-top"><span class="code">${esc(i.item)}</span><span class="pill" style="background:${pc}22;color:${pc}">${esc(label(i.priority))}</span><span class="pill" style="background:#2a2a2a;color:#cfcfcf">${esc(label(i.storage))}</span><span class="risk" style="background:${rc.bg};color:${rc.text}">${esc(label(i.poRisk))}</span></div><p class="desc">${esc(i.desc)}</p><div class="meta"><span>On hand: <strong>${fmt(i.onHand)}</strong></span><span>Usage: <strong>${fmt(i.usage)}</strong></span><span>Lead time: <strong>${i.leadTime==null?'—':fmt(i.leadTime)+' days'}</strong></span><span>Usage/inventory ratio: <strong>${fmt(i.ratio)}</strong></span><span>Recommended storage: <strong>${esc(i.recStorage)}</strong></span></div></div>`;
            }).join('')||'<p style="color:#aaa">No items match these filters.</p>';
            document.getElementById('itemCount').textContent=`${filtered.length} status entries representing ${filtered.reduce((s,i)=>s+weight(i),0)} item records`;
        };
        renderLeaderboard = function () {
            const max=Math.max(1,...exposureTop.map(r=>r.value??0));
            document.getElementById('lbList').innerHTML=exposureTop.map((row,index)=>{
                const color=index===0?'#CC0033':index===1?'#E0703C':index===2?'#D9A23B':'#777';
                const selected=globalFilter.selectedItem===(row.item??'');
                return `<div class="lb-row" role="button" tabindex="0" aria-pressed="${selected}" data-index="${index}" style="cursor:pointer;${selected?'outline:2px solid #CC0033;background:#252525':''}"><span class="lb-rank" style="background:${color}">${index+1}</span><span class="lb-code">${esc(row.item)}</span><div class="lb-track"><div class="lb-fill" style="width:${Math.max(0,row.value??0)/max*100}%;background:${color}"></div></div><span class="lb-val" title="Exposure score: ${esc(fmt(row.value))}">${compact(row.value)}</span></div>`;
            }).join('')||'<p style="color:#aaa">No procurement exposure results.</p>';
            document.querySelector('#viz-exposure .dcard-cap').textContent=`${exposureTop.length} entries ranked by lead-time-weighted procurement exposure. Click a bar to filter the breakdown, storage bars, and item cards; click again to clear.`;
            document.querySelectorAll('#lbList .lb-row').forEach(el=>{
                const activate=()=>{const key=exposureTop[Number(el.dataset.index)].item??'';globalFilter.selectedItem=globalFilter.selectedItem===key?null:key;globalFilter.searchTerm='';document.getElementById('globalSearch').value=globalFilter.selectedItem??'';renderAll();};
                el.addEventListener('click',activate);
                el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
            });
        };
        updateFilterStatus = function () {
            const count=getFilteredItems().reduce((s,i)=>s+weight(i),0);
            document.getElementById('globalFilterStatus').textContent=`${count} matching item records. KPI cards and gauges show overall totals.`;
        };
        renderAll = function () {renderHeatmap();renderStorageBars();renderItemList();renderLeaderboard();updateFilterStatus();};
    }

    async function load() {
        try {
            const response=await fetch('./data/analytics.json',{cache:'no-store'});
            if(!response.ok) throw Error(`HTTP ${response.status}`);
            const data=await response.json();
            if(data.schemaVersion!==2) {
                if(typeof data.totalPoQty==='number' && Number.isFinite(data.totalPoQty)) {
                    document.getElementById('total-po-qty').textContent=compact(data.totalPoQty);
                    document.getElementById('total-po-qty').title=`Total PO quantity: ${fmt(data.totalPoQty)}`;
                }
                status.textContent='Total PO quantity is connected. Other figures are a saved snapshot awaiting the full-page export.';
                return;
            }
            verify(data);
            current=data;
            items=data.items;
            exposureTop=[...data.exposure].sort((a,b)=>(b.value??-Infinity)-(a.value??-Infinity));
            for(const [id,key,currency] of [['total-po-qty','totalPoQty',false],['total-on-hand','totalOnHand',false],['total-inventory-value','totalInventoryValue',true]]) {
                const el=document.getElementById(id);
                el.textContent=(currency?'$':'')+(key==='totalPoQty' ? new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:0}).format(data[key]) : compact(data[key]));
                el.title=(currency?'$':'')+fmt(data[key]);
            }
            for(const [id,key] of [['fPriority','priority'],['fStorage','storage'],['fRisk','poRisk']]) {
                const select=document.getElementById(id);
                while(select.options.length>1)select.remove(1);
                populateSelect(id,items.map(i=>label(i[key])));
            }
            installRenderers();
            gauges();renderAll();
            const age=Date.now()-Date.parse(data.exportedAtUtc);
            status.textContent=`Website export: ${new Date(data.exportedAtUtc).toLocaleString()}. ${age>8*3600000?'Update is older than expected. ':''}This is the export time, not the source-data refresh time.`;
        } catch(error) {
            status.textContent='Current analytics could not be loaded. Displayed figures are a saved snapshot; do not treat them as a fresh update.';
            console.error('Current inventory update failed:',error);
        }
    }
    load();
})();
