"""Validate the complete export before replacing the last successful website data."""
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path


def number(value, label, nullable=False, count=False):
    if nullable and value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f'{label}: expected a finite number')
    if count and (value < 0 or int(value) != value):
        raise ValueError(f'{label}: expected a non-negative integer')
    return value


def stamp(value):
    if not isinstance(value, str):
        raise ValueError('Missing export timestamp')
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('Timestamp needs a time zone')
    if (dt - datetime.now(timezone.utc)).total_seconds() > 600:
        raise ValueError('Export timestamp is in the future')
    return dt


def rows(payload, key):
    raw = payload.get(key)
    if not isinstance(raw, list):
        raise ValueError(f'{key}: missing query result array')
    result = []
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError(f'{key}: invalid row')
        result.append({k[1:-1] if k.startswith('[') and k.endswith(']') else k: v
                       for k, v in row.items()})
    return result


def categories(payload, key, mapping):
    result = {v: 0 for v in mapping.values()}
    seen = set()
    for row in rows(payload, key):
        category = row.get('category')
        if category not in mapping or category in seen:
            raise ValueError(f'{key}: unknown or repeated category {category!r}; review Power BI classification')
        seen.add(category)
        result[mapping[category]] = number(row.get('count'), key, count=True)
    # An absent category in a successfully returned grouped query means zero.
    return result


def validate(payload):
    stamp(payload.get('exportedAtUtc'))
    if payload.get('schemaVersion') != 2:
        # Support the already-working one-card flow during installation only.
        return {'totalPoQty': number(payload.get('totalPoQty'), 'totalPoQty'),
                'exportedAtUtc': payload['exportedAtUtc']}
    kpis = rows(payload, 'kpis')
    if len(kpis) != 1:
        raise ValueError('Expected exactly one KPI row')
    k = kpis[0]
    result = {'schemaVersion': 2, 'exportedAtUtc': payload['exportedAtUtc'],
              'totalPoQty': number(k.get('SumPurchase_Order_Qty'), 'totalPoQty'),
              'totalOnHand': number(k.get('totalOnHand'), 'totalOnHand'),
              'totalInventoryValue': number(k.get('totalInventoryValue'), 'totalInventoryValue')}
    result['movement'] = categories(payload, 'movement', {
        'Active Inventory': 'active', 'Slow Moving': 'slow', 'Obsolete Inventory': 'obsolete'})
    result['service'] = categories(payload, 'service', {
        'Potential Stockout Before Delivery': 'risk',
        'Inventory Likely Covers Until Delivery': 'covered'})
    result['items'] = []
    texts = ['item', 'exposureItem', 'priority', 'poRisk', 'storage', 'desc', 'recStorage']
    nums = ['onHand', 'usage', 'leadTime', 'ratio']
    for row in rows(payload, 'items'):
        clean = {}
        for field in texts:
            value = row.get(field)
            if value is not None and not isinstance(value, str):
                raise ValueError(f'items.{field}: expected text')
            clean[field] = value
        for field in nums:
            clean[field] = number(row.get(field), field, nullable=True)
        clean['recordCount'] = number(row.get('recordCount'), 'recordCount', count=True)
        result['items'].append(clean)
    result['exposure'] = []
    seen = set()
    for row in rows(payload, 'exposure'):
        item = row.get('item')
        if item is not None and not isinstance(item, str):
            raise ValueError('exposure.item must be text')
        if item in seen:
            raise ValueError('Duplicate exposure item')
        seen.add(item)
        result['exposure'].append({'item': item, 'value': number(row.get('value'), 'exposure.value', nullable=True)})
    result['exposure'].sort(key=lambda r: (r['value'] is None, -(r['value'] or 0), r['item'] or ''))
    if result['totalPoQty'] != 0 and not result['items']:
        raise ValueError('Nonzero PO total but empty item export')
    if result['items'] and (sum(result['movement'].values()) == 0 or sum(result['service'].values()) == 0):
        raise ValueError('Items present but classification export empty')
    return result


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    data = validate(event['client_payload'])
    output = Path('data/analytics.json')
    if output.exists():
        previous = json.loads(output.read_text())
        if previous.get('schemaVersion') == 2 and data.get('schemaVersion') != 2:
            raise ValueError('Refusing to replace full-page data with an old one-card payload')
        if stamp(data['exportedAtUtc']) <= stamp(previous['exportedAtUtc']):
            print('Older or duplicate export; keeping current data.')
            return
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')
    temporary.replace(output)
    print('Validated analytics saved.')


if __name__ == '__main__':
    main()
