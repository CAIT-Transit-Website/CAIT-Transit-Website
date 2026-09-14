(function minmaxLive() {
    'use strict';

    const leads = ['Normal Lead Time', '15% Delay', '30% Delay'];
    const demands = ['Stable', 'Moderate', 'Spiky'];
    const policies = ['Lean', 'Balanced', 'High Service'];

    const key = (l, d, p) => JSON.stringify([l, d, p]);

    const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
        ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c])
    );

    const fmt = value =>
        value === null ? '—' : value.toLocaleString('en-US');

    function number(row, name, optional = false) {
        const value = row['[' + name + ']'];

        if (value == null && optional) return null;

        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error('Invalid or missing ' + name);
        }

        return value;
    }

    function scenario(row) {
        const l = row['[leadTime]'];
        const d = row['[demand]'];
        const p = row['[policy]'];

        if (
            !leads.includes(l) ||
            !demands.includes(d) ||
            !policies.includes(p)
        ) {
            throw new Error('Unrecognized Min-Max scenario.');
        }

        return key(l, d, p);
    }

    function replaceObject(target, source) {
        Object.keys(target).forEach(k => delete target[k]);
        Object.assign(target, source);
    }

    function money(value) {
        const n = Math.abs(value);
        const sign = value < 0 ? '-' : '';

        if (n >= 1e6) {
            return sign + '$' + (n / 1e6).toFixed(2) + 'M';
        }

        if (n >= 1e3) {
            return sign + '$' + (n / 1e3).toFixed(0) + 'K';
        }

        return sign + '$' + n.toFixed(0);
    }

    function statusElement() {
        let el = document.getElementById('minmax-sync-status');

        if (!el) {
            el = document.createElement('p');
            el.id = 'minmax-sync-status';
            el.setAttribute('role', 'status');
            el.style.cssText =
                'margin:-8px 0 14px;color:#b8b8b8;font-size:12px';

            const row = document.getElementById('viz-mm-kpis');
            row.parentElement.insertBefore(el, row);
        }

        return el;
    }

    function prepare(data) {
        if (data.schemaVersion !== 1 || !data.kpis) {
            throw new Error('Unexpected Min-Max export format.');
        }

        for (const name of [
            'policyComparison',
            'stockoutRisk',
            'valueReduction',
            'recommendations'
        ]) {
            if (!Array.isArray(data[name])) {
                throw new Error('Missing ' + name);
            }
        }

        const exported = new Date(data.exportedAtUtc);

        if (!Number.isFinite(exported.getTime())) {
            throw new Error('Invalid export time.');
        }

        const kpis = [
            'Parts_Evaluated',
            'NIVR',
            'Validated_Recommendations',
            'Replenishment_Workload_Multiple'
        ].map(name => number(data.kpis, name));

        const comparisons = new Map();
        const riskGroups = new Map();
        const recGroups = new Map();

        for (const row of data.policyComparison) {
            const id = scenario(row);
            const comparison = row['[comparison]'];

            if (!['Current Policy', 'Selected Policy'].includes(comparison)) {
                throw new Error('Unrecognized policy comparison.');
            }

            if (!comparisons.has(id)) {
                comparisons.set(id, {});
            }

            const pair = comparisons.get(id);

            if (pair[comparison]) {
                throw new Error('Duplicate policy comparison.');
            }

            const value = number(row, 'inventoryValue');
            const fillRate = number(row, 'fillRate');

            if (fillRate < 0 || fillRate > 1) {
                throw new Error('Invalid fill rate.');
            }

            pair[comparison] = {value, fillRate};
        }

        for (const row of data.stockoutRisk) {
            const id = scenario(row);

            if (!riskGroups.has(id)) {
                riskGroups.set(id, []);
            }

            riskGroups.get(id).push(row);
        }

        // Keep every exported item, including missing current thresholds.
        for (const row of data.recommendations) {
            const id = scenario(row);
            const item = row['[item]'];

            if (typeof item !== 'string' || !item.trim()) {
                throw new Error('Missing item code.');
            }

            if (!recGroups.has(id)) {
                recGroups.set(id, new Map());
            }

            const group = recGroups.get(id);

            if (group.has(item)) {
                throw new Error(
                    'Duplicate item in one scenario: ' + item
                );
            }

            group.set(item, {
                item,
                desc: String(row['[description]'] ?? ''),
                curMin: number(row, 'currentMin', true),
                curMax: number(row, 'currentMax', true),
                recMin: number(row, 'recommendedMin', true),
                recMax: number(row, 'recommendedMax', true)
            });
        }

        const cp = {};
        const sp = {};
        const repl = {};
        const risk = {};
        const vr = {};
        const recommendations = new Map();

        for (const l of leads) {
            cp[l] = {};
            sp[l] = {};
            repl[l] = {};
            risk[l] = {};

            for (const d of demands) {
                sp[l][d] = {};
                repl[l][d] = {};
                risk[l][d] = {};

                for (const p of policies) {
                    const id = key(l, d, p);
                    const pair = comparisons.get(id);

                    if (
                        !pair?.['Current Policy'] ||
                        !pair?.['Selected Policy']
                    ) {
                        throw new Error(
                            'Missing policy comparison: ' + id
                        );
                    }

                    cp[l][d] = pair['Current Policy'];
                    sp[l][d][p] = pair['Selected Policy'];
                    repl[l][d][p] = kpis[3];

                    const rows = riskGroups.get(id);

                    if (!rows?.length) {
                        throw new Error(
                            'Missing stockout distribution: ' + id
                        );
                    }

                    const total = number(rows[0], 'totalItems');
                    const orders = new Set();

                    const bands = rows.map(row => {
                        const order = number(row, 'bandOrder');
                        const n = number(row, 'itemCount', true) ?? 0;
                        const fraction =
                            number(row, 'percentage', true) ?? 0;
                        const label = row['[riskBand]'];

                        if (
                            orders.has(order) ||
                            typeof label !== 'string' ||
                            !Number.isInteger(n) ||
                            n < 0 ||
                            fraction < 0 ||
                            fraction > 1 ||
                            number(row, 'totalItems') !== total
                        ) {
                            throw new Error('Invalid stockout band.');
                        }

                        orders.add(order);

                        return {
                            label,
                            n,
                            order,
                            pct: Math.round(fraction * 1000) / 10
                        };
                    }).sort((a, b) => a.order - b.order);

                    if (
                        bands.reduce((sum, b) => sum + b.n, 0) !== total
                    ) {
                        throw new Error(
                            'Stockout counts do not match the item total.'
                        );
                    }

                    risk[l][d][p] = {total, bands};

                    const group = recGroups.get(id);

                    if (!group?.size) {
                        throw new Error(
                            'Missing recommendations: ' + id
                        );
                    }

                    recommendations.set(
                        id,
                        [...group.values()].sort(
                            (a, b) => a.item.localeCompare(b.item)
                        )
                    );
                }
            }
        }

        for (const p of policies) {
            vr[p] = data.valueReduction
                .filter(row => row['[policy]'] === p)
                .map(row => {
                    if (typeof row['[item]'] !== 'string') {
                        throw new Error('Missing leaderboard item.');
                    }

                    return {
                        item: row['[item]'],
                        value: number(row, 'value')
                    };
                })
                .sort((a, b) => b.value - a.value)
                .slice(0, 8);

            if (!vr[p].length) {
                throw new Error('Missing value reduction for ' + p);
            }
        }

        return {
            exported,
            kpis,
            comparisons,
            cp,
            sp,
            repl,
            risk,
            vr,
            recommendations
        };
    }

    function installRecommendationTable(groups) {
        const search = document.getElementById('mmRecSearch');

        // Disconnect the previous search handler before replacing it.
        search.removeEventListener(
            'input',
            renderMmRecommendationTable
        );

        renderMmRecommendationTable = function () {
            const {leadTime, demand, policy} = mmState;

            const rows =
                groups.get(key(leadTime, demand, policy)) || [];

            const term = search.value.trim().toLowerCase();

            const filtered = rows.filter(r =>
                (r.item + ' ' + r.desc)
                    .toLowerCase()
                    .includes(term)
            );

            const wrap = document.getElementById('mmRecTableWrap');

            wrap.innerHTML = `
                <table class="crosstab-table">
                    <thead>
                        <tr>
                            <th style="text-align:left">Item</th>
                            <th style="text-align:left">Description</th>
                            <th>Current Min</th>
                            <th>Current Max</th>
                            <th>Recommended Min</th>
                            <th>Recommended Max</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${filtered.map(r => `
                            <tr
                                class="${r.item === mmSelectedItem ? 'mm-rec-selected-row' : ''}"
                                data-item="${esc(r.item)}"
                            >
                                <td style="text-align:left;font-family:'IBM Plex Mono',monospace;font-size:11px">
                                    ${esc(r.item)}
                                </td>
                                <td style="text-align:left">
                                    ${esc(r.desc)}
                                </td>
                                <td>${fmt(r.curMin)}</td>
                                <td>${fmt(r.curMax)}</td>
                                <td style="color:${r.recMin === null ? 'var(--dark-muted)' : '#27AE60'};font-weight:600">
                                    ${fmt(r.recMin)}
                                </td>
                                <td style="color:${r.recMax === null ? 'var(--dark-muted)' : '#27AE60'};font-weight:600">
                                    ${fmt(r.recMax)}
                                </td>
                            </tr>
                        `).join('') ||
                        '<tr><td colspan="6">No items match your search.</td></tr>'}
                    </tbody>
                </table>
            `;

            document.getElementById('mmRecCount').textContent =
                `Showing ${filtered.length} of ${rows.length} items — ${policy}, ${demand}, ${leadTime}.`;

            const selected =
                wrap.querySelector('.mm-rec-selected-row');

            if (selected) {
                selected.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        };

        search.addEventListener(
            'input',
            renderMmRecommendationTable
        );

        const caption = document.querySelector(
            '#viz-mm-recommendation .dcard-cap'
        );

        if (caption) {
            caption.textContent =
                'Current min/max per item and recommended min/max for the selected lead time, demand profile, and policy. A dash means no value was provided.';
        }

        const definition = document.querySelector(
            '#tabMinMax .term-item[onclick*="viz-mm-recommendation"] .term-desc'
        );

        if (definition) {
            definition.textContent =
                'Current minimum and maximum stock levels alongside recommended levels for the selected scenario and policy.';
        }
    }

    function installStockoutRenderer() {
        renderStockoutDist = function () {
            const dist =
                STOCKOUT_DIST[mmState.leadTime][mmState.demand][mmState.policy];

            const max = Math.max(1, ...dist.bands.map(b => b.pct));

            document.getElementById('stockoutDistWrap').innerHTML =
                dist.bands.map((b, i) => `
                    <div class="storage-bar-row">
                        <span class="label" style="width:120px">
                            ${esc(b.label)}
                        </span>
                        <div class="storage-bar-track">
                            <div
                                class="storage-bar-fill"
                                style="width:${b.pct / max * 100}%;background:${BAND_COLORS[i] || '#777'}"
                            ></div>
                        </div>
                        <span
                            class="n"
                            style="width:64px"
                            title="${b.n} items"
                        >${b.pct}%</span>
                    </div>
                `).join('');

            document.getElementById('stockoutDistCaveat').textContent =
                `Based on ${dist.total.toLocaleString()} evaluated items in the selected scenario.`;
        };

        const caption = document.querySelector(
            '#viz-stockout-dist .dcard-cap'
        );

        if (caption) {
            caption.textContent =
                'Share of evaluated items in each stockout-day risk band for the selected lead time, demand profile, and policy.';
        }
    }

    async function load() {
        const status = statusElement();

        status.textContent =
            'Loading Min-Max analytics; existing figures are a saved snapshot.';

        let applied = false;

        try {
            const response = await fetch(
                './data/minmax.json',
                {cache: 'no-store'}
            );

            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }

            const ready = prepare(await response.json());

            replaceObject(mmCurrentPolicy, ready.cp);
            replaceObject(mmSelectedPolicy, ready.sp);
            replaceObject(mmReplenishment, ready.repl);
            replaceObject(mmValueReduction, ready.vr);
            replaceObject(STOCKOUT_DIST, ready.risk);

            applied = true;

            const values = [
                fmt(ready.kpis[0]),
                money(ready.kpis[1]),
                fmt(ready.kpis[2]),
                ready.kpis[3].toFixed(2) + 'x'
            ];

            const labels = [
                'Parts evaluated',
                'NIVR',
                'Validated recommendations',
                'Replenishment workload multiple'
            ];

            document
                .querySelectorAll('#viz-mm-kpis .dark-kpi')
                .forEach((card, i) => {
                    const value = card.querySelector('.val');

                    if (value) {
                        value.textContent = values[i];
                    }

                    card.title = labels[i] + ': ' + values[i];
                    card.setAttribute('aria-label', card.title);
                });

            installRecommendationTable(ready.recommendations);
            installStockoutRenderer();

            const previousUpdate = updateMinMax;

            updateMinMax = function () {
                const {leadTime, demand, policy} = mmState;

                mmCurrentPolicy[leadTime][demand] =
                    ready.comparisons.get(
                        key(leadTime, demand, policy)
                    )['Current Policy'];

                previousUpdate();
            };

            updateMinMax();

            const readable = new Intl.DateTimeFormat('en-US', {
                dateStyle: 'medium',
                timeStyle: 'medium',
                timeZone: 'America/New_York'
            }).format(ready.exported);

            status.textContent =
                'Website data refreshed ' + readable + ' ET';

            status.title =
                'Power BI export timestamp: ' +
                ready.exported.toISOString();

            status.style.color = '#b8b8b8';

        } catch (error) {
            status.textContent = applied
                ? 'Min-Max display update failed; some figures may be incomplete.'
                : 'Live Min-Max export could not be loaded; showing the saved page snapshot.';

            status.style.color = '#f2994a';

            console.error(
                'Min-Max live data update failed:',
                error
            );
        }
    }

    return load();
})();
