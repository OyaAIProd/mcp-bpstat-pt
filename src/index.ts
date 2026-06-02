interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * BPstat — Banco de Portugal statistics API (Portuguese central bank). Keyless.
 *
 * API structure (verified live against https://bpstat.bportugal.pt/data/v1):
 *   /domains/                         -> flat list of statistical domains (tree via parent_id)
 *   /domains/{id}/datasets/           -> JSON-stat collection of datasets in a domain
 *   /domains/{id}/datasets/{ds}/      -> JSON-stat dataset: this IS the data-access endpoint.
 *                                        It carries inline observations (value[]/status[]) aligned
 *                                        to the reference_date dimension, plus extension.series[]
 *                                        (id + label) for every series in the dataset.
 *   /series/?series_ids=1,2,3         -> series METADATA only (label, description, dataset_id,
 *                                        domain_ids, dimension_category). NOTE: this endpoint does
 *                                        NOT return observations — to get values, fetch the parent
 *                                        dataset. There is no /series/{id}/ or /observations/ path
 *                                        (both return 404).
 *
 * Content is Portuguese by default (label/short_label/description). Pass lang=EN for English;
 * both PT and EN are verified working.
 */


const BASE = 'https://bpstat.bportugal.pt/data/v1';
const UA = 'pipeworx-mcp-bpstat-pt/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'list_domains',
    description:
      "List Banco de Portugal's statistical domains (the full subject tree). Each domain has " +
      'id, parent_id (tree links; null = top level), label/short_label/description (Portuguese by ' +
      "default), num_series, num_datasets, and has_series. Start here, then use a domain id with " +
      'list_datasets. lang defaults to PT; pass "EN" for English.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: { type: 'string', description: 'Language: "PT" (default) or "EN".' },
      },
    },
  },
  {
    name: 'list_datasets',
    description:
      'List the datasets within a statistical domain (use a domain id from list_domains). Returns a ' +
      'JSON-stat collection; each item has extension.id (the dataset id, a hex string) and ' +
      'extension.num_series. The dataset id feeds get_dataset. lang defaults to PT.',
    inputSchema: {
      type: 'object',
      properties: {
        domain_id: { type: 'integer', description: 'Domain id from list_domains, e.g. 3 (Balança de pagamentos).' },
        lang: { type: 'string', description: 'Language: "PT" (default) or "EN".' },
      },
      required: ['domain_id'],
    },
  },
  {
    name: 'get_dataset',
    description:
      'Fetch a dataset as JSON-stat — THIS is how you get actual data/observations. Returns the value[] ' +
      'and status[] arrays plus the dimension objects; observations align to dimension.reference_date ' +
      '(the time axis, ISO dates). extension.series[] lists every series (id + Portuguese label) the ' +
      'dataset contains. Requires both the parent domain_id and the dataset id (from list_datasets). ' +
      'Large datasets can be sizeable. lang defaults to PT.',
    inputSchema: {
      type: 'object',
      properties: {
        domain_id: { type: 'integer', description: 'Parent domain id (from list_domains / list_datasets).' },
        dataset_id: { type: 'string', description: 'Dataset id, e.g. "05e2845d5d567afd88b699a91b0c20b8".' },
        lang: { type: 'string', description: 'Language: "PT" (default) or "EN".' },
      },
      required: ['domain_id', 'dataset_id'],
    },
  },
  {
    name: 'get_series_metadata',
    description:
      'Look up metadata for one or more series by numeric series id. Returns label, short_label, ' +
      'description (Portuguese by default), dataset_id, domain_ids, and dimension_category. Use this ' +
      'to identify a series and find which dataset_id holds its observations, then call get_dataset. ' +
      'NOTE: this endpoint returns metadata only — it does NOT return the numeric values. lang defaults to PT.',
    inputSchema: {
      type: 'object',
      properties: {
        series_ids: {
          type: 'string',
          description: 'One or more numeric series ids, comma-separated, e.g. "8201" or "8201,8202".',
        },
        lang: { type: 'string', description: 'Language: "PT" (default) or "EN".' },
      },
      required: ['series_ids'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const lang = normLang(args.lang);
  switch (name) {
    case 'list_domains':
      return bpGet(`/domains/?lang=${lang}`);
    case 'list_datasets': {
      const domainId = reqInt(args, 'domain_id', '3');
      return bpGet(`/domains/${domainId}/datasets/?lang=${lang}`);
    }
    case 'get_dataset': {
      const domainId = reqInt(args, 'domain_id', '3');
      const datasetId = reqStr(args, 'dataset_id', '"05e2845d5d567afd88b699a91b0c20b8"');
      return bpGet(`/domains/${domainId}/datasets/${encodeURIComponent(datasetId)}/?lang=${lang}`);
    }
    case 'get_series_metadata': {
      const ids = reqStr(args, 'series_ids', '"8201" or "8201,8202"').replace(/\s+/g, '');
      return bpGet(`/series/?series_ids=${encodeURIComponent(ids)}&lang=${lang}`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function bpGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`BPstat: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

function normLang(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return s === 'EN' ? 'EN' : 'PT';
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v.trim();
}

function reqInt(args: Record<string, unknown>, key: string, example: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`Required argument "${key}" is missing. Pass an integer like ${example}.`);
  return n;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
