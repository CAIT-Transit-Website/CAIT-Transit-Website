/* Live Min-Max export loader */
(() => {
    'use strict';

    const leads = ['Normal Lead Time', '15% Delay', '30% Delay'];
    const demands = ['Stable', 'Moderate', 'Spiky'];
    const policies = ['Lean', 'Balanced', 'High Service'];
    const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
    const key = (l, d, p) => l + '|' + d + '|' + p;

    function replaceObject(target, source) {
        Object.keys(target).forEach(k => delete target[k]);
        Object.assign(target, source);
    }

    function money(v) {
        const n = Math.abs(v);
        const sign = v < 0 ? '-' : '';
        if (n >= 1e6) return sign + '$' + (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return sign + '$' + (n / 1e3).toFixed(0) + 'K';
        return sign + '$' + n.toFixed(0);
    }

    function statusElement() {
        let el = document.getElementById('minmax-sync-status');
        if (el) return el;

        const row = document.getElementById('viz-mm-kpis');
        if (!row || !row.parentElement) return null;

        el = document.createElement('p');
        el.id = 'minmax-sync-status';
        el.setAttribute('role', 'status');
        el.style.cssText =
            'margin:-8px 0 14px;color:#b8b8b8;font-size:12px';

        row.parentElement.insertBefore(el, row);
        return el;
    }

    function stockoutRenderer() {
        renderStockoutDist = function () {
            const dist =
                STOCKOUT_DIST[mmState.leadTime][mmState.demand][mmState.policy];

            const wrap = document.getElementById('stockoutDistWrap');
            const max = Math.max(1, ...dist.bands.map(b => b.pct));

            wrap.innerHTML = dist.bands.map((b, i) =>
                '<div class="storage-bar-row">' +
                '<span class="label" style="width:120px">' + b.label + '</span>' +
                '<div class="storage-bar-track"><div class="storage-bar-fill" style="width:' +
                (b.pct / max * 100) +
                '%;background:' + BAND_COLORS[i] + '"></div></div>' +
                '<span class="n" style="width:64px">' + b.pct + '%</span>' +
                '</div>'
            ).join('');

            document.getElementById('stockoutDistCaveat').textContent =
                'Based on ' + dist.total.toLocaleString() +
                ' evaluated items in the selected scenario. Percentages come from the published Min-Max export.';
        };
    }

    function apply(data) {
        if (
            data.schemaVersion !== 1 ||
            !data.kpis ||
            !Array.isArray(data.policyComparison) ||
            !Array.isArray(data.stockoutRisk) ||
            !Array.isArray(data.valueReduction) ||
            !Array.isArray(data.recommendations)
        ) {
            throw new Error('The Min-Max export is incomplete or has the wrong schema.');
        }

        const k = data.kpis;
        const current = {};
        const selected = {};

        data.policyComparison.forEach(r => {
            const l = r['[leadTime]'];
            const d = r['[demand]'];
            const p = r['[policy]'];

            const value = num(r['[inventoryValue]']);
            const fill = num(r['[fillRate]']);

            if (
                !leads.includes(l) ||
                !demands.includes(d) ||
                !policies.includes(p) ||
                value === null ||
                fill === null
            ) return;

            if (r['[comparison]'] === 'Current Policy') {
                if (!current[l + '|' + d]) {
                    current[l + '|' + d] = {
                        value,
                        fillRate: fill
                    };
                }
            }

            if (r['[comparison]'] === 'Selected Policy') {
                selected[key(l, d, p)] = {
                    value,
                    fillRate: fill
                };
            }
        });

        const cp = {};
        const sp = {};
        const repl = {};

        leads.forEach(l => {
            cp[l] = {};
            sp[l] = {};
            repl[l] = {};

            demands.forEach(d => {
                const c = current[l + '|' + d];

                if (!c) {
                    throw new Error('Missing current policy result.');
                }

                cp[l][d] = c;
                sp[l][d] = {};
                repl[l][d] = {};

                policies.forEach(p => {
                    const s = selected[key(l, d, p)];

                    if (!s) {
                        throw new Error('Missing selected policy result.');
                    }

                    sp[l][d][p] = s;
                    repl[l][d][p] =
                        k['[Replenishment_Workload_Multiple]'];
                });
            });
        });

        const vr = {};

        policies.forEach(p => {
            vr[p] = data.valueReduction
                .filter(r =>
                    r['[policy]'] === p &&
                    typeof r['[item]'] === 'string' &&
                    num(r['[value]']) !== null
                )
                .map(r => ({
                    item: r['[item]'],
                    value: num(r['[value]'])
                }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 8);

            if (!vr[p].length) {
                throw new Error('Missing value-reduction rows.');
            }
        });

        const riskRows = {};

        data.stockoutRisk.forEach(r => {
            const l = r['[leadTime]'];
            const d = r['[demand]'];
            const p = r['[policy]'];

            if (
                !leads.includes(l) ||
                !demands.includes(d) ||
                !policies.includes(p)
            ) return;

            const id = key(l, d, p);

            if (!riskRows[id]) {
                riskRows[id] = [];
            }

            riskRows[id].push(r);
        });

        const risk = {};

        leads.forEach(l => {
            risk[l] = {};

            demands.forEach(d => {
                risk[l][d] = {};

                policies.forEach(p => {
                    const rows = riskRows[key(l, d, p)];

                    if (!rows || !rows.length) {
                        throw new Error('Missing stockout-risk rows.');
                    }

                    const bands = rows
                        .slice()
                        .sort((a, b) =>
                            (num(a['[bandOrder]']) || 0) -
                            (num(b['[bandOrder]']) || 0)
                        )
                        .map(r => ({
                            label: String(
                                r['[riskBand]'] ?? 'Unclassified'
                            ),
                            n: Math.max(
                                0,
                                num(r['[itemCount]']) || 0
                            ),
                            pct: Math.round(
                                Math.max(
                                    0,
                                    num(r['[percentage]']) || 0
                                ) * 1000
                            ) / 10
                        }));

                    risk[l][d][p] = {
                        total: bands.reduce(
                            (sum, b) => sum + b.n,
                            0
                        ),
                        bands
                    };
                });
            });
        });

        const thresholds = {};
        const balanced = {};

        leads.forEach(l => {
            balanced[l] = {};

            demands.forEach(d => {
                balanced[l][d] = {};
            });
        });

        data.recommendations.forEach(r => {
            const item = r['[item]'];

            if (typeof item !== 'string') {
                return;
            }

            if (
                !thresholds[item] &&
                num(r['[currentMin]']) !== null &&
                num(r['[currentMax]']) !== null
            ) {
                thresholds[item] = {
                    item,
                    desc: String(r['[description]'] ?? ''),
                    cur_min: num(r['[currentMin]']),
                    cur_max: num(r['[currentMax]'])
                };
            }

            if (
                r['[policy]'] === 'Balanced' &&
                leads.includes(r['[leadTime]']) &&
                demands.includes(r['[demand]']) &&
                num(r['[recommendedMin]']) !== null &&
                num(r['[recommendedMax]']) !== null
            ) {
                balanced[r['[leadTime]']][r['[demand]']][item] = {
                    sel_min: num(r['[recommendedMin]']),
                    sel_max: num(r['[recommendedMax]'])
                };
            }
        });

        replaceObject(mmReplenishment, repl);
        replaceObject(mmCurrentPolicy, cp);
        replaceObject(mmSelectedPolicy, sp);
        replaceObject(mmValueReduction, vr);
        replaceObject(STOCKOUT_DIST, risk);

        mmCurrentThresholds.splice(
            0,
            mmCurrentThresholds.length,
            ...Object.values(thresholds).sort(
                (a, b) => a.item.localeCompare(b.item)
            )
        );

        replaceObject(
            mmSelectedThresholdsBalanced,
            balanced
        );

        const values = [
            k['[Parts_Evaluated]'].toLocaleString('en-US'),
            money(k['[NIVR]']),
            k['[Validated_Recommendations]']
                .toLocaleString('en-US'),
            k['[Replenishment_Workload_Multiple]']
                .toFixed(2) + 'x'
        ];

        const titles = [
            'Parts evaluated: ' + values[0],
            'NIVR: ' + values[1],
            'Validated recommendations: ' + values[2],
            'Replenishment workload multiple: ' + values[3]
        ];

        document
            .querySelectorAll('#viz-mm-kpis .dark-kpi')
            .forEach((card, i) => {
                const value = card.querySelector('.val');

                if (value && values[i] !== undefined) {
                    value.textContent = values[i];
                }

                if (titles[i]) {
                    card.title = titles[i];
                    card.setAttribute(
                        'aria-label',
                        titles[i]
                    );
                }
            });

        stockoutRenderer();
        updateMinMax();

        const date = new Date(data.exportedAtUtc);
        const status = statusElement();

        if (status) {
            status.textContent =
                'Website data refreshed ' +
                new Intl.DateTimeFormat('en-US', {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                    timeZone: 'America/New_York'
                }).format(date) + 'ET';
                

            status.title =
                'Power BI export timestamp: ' +
                date.toISOString();
        }
    }

    (async () => {
        try {
            const response = await fetch(
                './data/minmax.json',
                {cache: 'no-store'}
            );

            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }

            const data = await response.json();

            if (
                !Number.isFinite(
                    Date.parse(data.exportedAtUtc)
                )
            ) {
                throw new Error('Invalid export timestamp.');
            }

            apply(data);
        } catch (error) {
            const status = statusElement();

            if (status) {
                status.textContent =
                    'Live Min-Max export could not be loaded; showing the saved page snapshot.';
                status.style.color = '#f2994a';
            }

            console.error(
                'Min-Max live data update failed:',
                error
            );
        }
    })();
})();
