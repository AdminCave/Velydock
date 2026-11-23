// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { translate } from '$lib/i18n';
import { translations } from '$lib/i18n/dictionaries';
import {
  OPTION_KEYS,
  PROXY_DEFAULTS,
  PUBLICATION_PROBLEMS,
  RESERVED_NAMES,
  builtinKey,
  headersToText,
  middlewaresToText,
  optionApplies,
  optionBaseline,
  optionValue,
  optionsToSend,
  parseHeaders,
  parseMiddlewares,
  pruneOptions,
  publicAddress,
  publicationNameProblem,
  rateLimitProblem,
  releaseProblem,
  sameOption,
  samePublication,
  splitOptions,
  suggestPublicationName,
  targetProblem,
  withOption,
  type Publication,
} from './proxy';
import { optionSummary, templateText } from './proxyText';

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);
const en = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('en', key, vars);

const INFO = {
  path_base: 'https://apps.example.com/',
  subdomain_scheme: 'https',
  subdomain_suffix: '.apps.example.com',
};

describe('the name of a publication', () => {
  it('is lower-case letters, digits and hyphens, 2 to 40 characters, as the API has it', () => {
    for (const good of ['wiki', 'a1', 'nas-buero', 'x'.repeat(40), ' Wiki ']) {
      expect(publicationNameProblem(good), good).toBeNull();
    }
    for (const bad of ['a', '-wiki', 'wiki-', 'wi ki', 'wiki_2', 'wíki', 'x'.repeat(41), 'a.b']) {
      expect(publicationNameProblem(bad), bad).toBe('proxy.name.invalid');
    }
    expect(publicationNameProblem('  ')).toBe('validation.required');
  });

  it('is not one of the names the installation needs itself, and no punycode', () => {
    for (const name of ['api', 'auth', 'www', 'velydock', 'Admin']) {
      expect(publicationNameProblem(name), name).toBe('proxy.name.reserved');
    }
    // The list is the API's (RESERVED_NAMES in services/proxy.py).
    expect([...RESERVED_NAMES].sort()).toEqual(
      'admin api apps assets auth dock favicon health internal login logout realms resources robots sandbox static status velydock www'.split(
        ' ',
      ),
    );
    expect(publicationNameProblem('xn--wiki-4ya')).toBe('proxy.name.invalid');
  });

  it('is suggested from the name of the app', () => {
    expect(suggestPublicationName('Wiki für alle')).toBe('wiki-fuer-alle');
    expect(suggestPublicationName('  NAS (Büro)  ')).toBe('nas-buero');
    expect(suggestPublicationName('Straße & Größe')).toBe('strasse-groesse');
    // Never longer than a name may be, and never ending in a hyphen because of the cut.
    const long = suggestPublicationName('Ein sehr langer Name für eine App die viel kann und mehr');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(publicationNameProblem(long)).toBeNull();
    // Nothing usable, or a reserved word: no suggestion rather than a name that is refused.
    expect(suggestPublicationName('…')).toBe('');
    expect(suggestPublicationName('X')).toBe('');
    expect(suggestPublicationName('API')).toBe('');
  });
});

describe('the internal address', () => {
  it('is http or https with a host and optionally a port', () => {
    for (const good of [
      'http://10.20.0.7:8080',
      'https://nas.intern',
      'http://10.20.0.7/',
      ' HTTP://NAS.intern:80 ',
      'http://[fd00::7]:8080',
    ]) {
      expect(targetProblem(good), good).toBeNull();
    }
    for (const bad of [
      '10.20.0.7:8080',
      'nas.intern',
      'ftp://nas.intern',
      'http://',
      'http://user:secret@nas.intern',
      'http:nas.intern',
    ]) {
      expect(targetProblem(bad), bad).toBe('proxy.target.invalid');
    }
    expect(targetProblem('')).toBe('validation.required');
  });

  it('has no path, query or fragment, and says that in its own words', () => {
    for (const bad of ['http://nas.intern/app', 'http://nas.intern/?a=1', 'http://nas.intern/#x']) {
      expect(targetProblem(bad), bad).toBe('proxy.target.path');
    }
    expect(de('proxy.target.path')).toContain('keinen Pfad');
  });
});

describe('the public address', () => {
  it('is built from what the installation says about its apps host', () => {
    expect(publicAddress(INFO, 'path', 'wiki')).toBe('https://apps.example.com/wiki/');
    expect(publicAddress(INFO, 'subdomain', 'wiki')).toBe('https://wiki.apps.example.com/');
    expect(publicAddress(INFO, 'subdomain', ' Wiki ')).toBe('https://wiki.apps.example.com/');
    expect(publicAddress({ ...INFO, subdomain_scheme: 'http' }, 'subdomain', 'nas')).toBe(
      'http://nas.apps.example.com/',
    );
  });

  it('is empty without a name, and while the installation has not said anything', () => {
    expect(publicAddress(INFO, 'path', '')).toBe('');
    expect(publicAddress(null, 'path', 'wiki')).toBe('');
    expect(
      publicAddress({ path_base: '', subdomain_scheme: '', subdomain_suffix: '' }, 'path', 'wiki'),
    ).toBe('');
    expect(
      publicAddress(
        { path_base: '', subdomain_scheme: '', subdomain_suffix: '' },
        'subdomain',
        'wiki',
      ),
    ).toBe('');
  });
});

describe('proxy options', () => {
  const embeddable = { options: { allow_embedding: true } };

  it('start from the defaults of the API, then the template', () => {
    expect(optionBaseline(null)).toEqual(PROXY_DEFAULTS);
    expect(optionBaseline(null, embeddable).allow_embedding).toBe(true);
    // What the installation says wins over what this version assumes.
    expect(optionBaseline({ pass_host_header: false }).pass_host_header).toBe(false);
    expect(
      optionBaseline({ pass_host_header: false }, { options: { pass_host_header: true } }),
    ).toMatchObject({ pass_host_header: true });
    // Only the options a form offers: own middlewares are no part of the baseline.
    expect(
      Object.keys(optionBaseline(null, { options: { custom_middlewares: { a: {} } } })).sort(),
    ).toEqual([...OPTION_KEYS].sort());
  });

  it('keep only what deviates: a value set back to the baseline is no deviation', () => {
    const base = optionBaseline(null, embeddable);
    let own = withOption({}, base, 'strip_prefix', false);
    expect(own).toEqual({ strip_prefix: false });
    own = withOption(own, base, 'allow_embedding', false);
    expect(own).toEqual({ strip_prefix: false, allow_embedding: false });
    own = withOption(own, base, 'strip_prefix', true);
    expect(own).toEqual({ allow_embedding: false });
    own = withOption(own, base, 'allow_embedding', true);
    expect(own).toEqual({});
    // Objects count by what they hold.
    own = withOption({}, base, 'request_headers', {});
    expect(own).toEqual({});
    own = withOption({}, base, 'rate_limit', { average: 20, burst: 40 });
    expect(own).toEqual({ rate_limit: { average: 20, burst: 40 } });
    expect(optionValue(own, base, 'rate_limit')).toEqual({ average: 20, burst: 40 });
    expect(optionValue(own, base, 'allow_embedding')).toBe(true);
  });

  it('drop what another template gives anyway, and keep the rest', () => {
    const own = { allow_embedding: true, strip_prefix: false, custom_middlewares: { a: {} } };
    expect(pruneOptions(own, optionBaseline(null, embeddable))).toEqual({
      strip_prefix: false,
      custom_middlewares: { a: {} },
    });
    expect(pruneOptions(own, optionBaseline(null))).toEqual(own);
  });

  it('compare by content: the order of keys is no difference, null and nothing are one', () => {
    expect(sameOption({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameOption({ average: 20, burst: 40 }, { average: 20, burst: 41 })).toBe(false);
    expect(sameOption(null, undefined)).toBe(true);
    expect(sameOption({}, null)).toBe(false);
    expect(sameOption(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('apply only where they have an effect', () => {
    const path = { mode: 'path', target: 'https://nas.intern', access: 'protected' } as const;
    expect(OPTION_KEYS.filter((key) => !optionApplies(key, path))).toEqual([]);
    expect(optionApplies('strip_prefix', { ...path, mode: 'subdomain' })).toBe(false);
    expect(optionApplies('verify_upstream_tls', { ...path, target: 'http://nas.intern' })).toBe(
      false,
    );
    expect(optionApplies('verify_upstream_tls', { ...path, target: ' HTTPS://nas.intern' })).toBe(
      true,
    );
    expect(optionApplies('identity_headers', { ...path, access: 'public' })).toBe(false);
    // A template has no publication to go by: everything applies.
    expect(OPTION_KEYS.filter((key) => !optionApplies(key, null))).toEqual([]);
  });

  it('are sent without what has no effect for this publication', () => {
    const own = {
      strip_prefix: false,
      verify_upstream_tls: false,
      identity_headers: true,
      allow_embedding: true,
      custom_middlewares: { office: {} },
    };
    expect(
      optionsToSend(own, { mode: 'subdomain', target: 'http://nas.intern', access: 'public' }),
    ).toEqual({ allow_embedding: true, custom_middlewares: { office: {} } });
    expect(
      optionsToSend(own, { mode: 'path', target: 'https://nas.intern', access: 'protected' }),
    ).toEqual(own);
  });

  it('limit requests within what the API takes', () => {
    expect(rateLimitProblem({ average: 1, burst: 1 })).toBeNull();
    expect(rateLimitProblem({ average: 10_000, burst: 100_000 })).toBeNull();
    expect(rateLimitProblem({ average: 0, burst: 10 })).toBe('proxy.rate.average');
    expect(rateLimitProblem({ average: 10_001, burst: 20_000 })).toBe('proxy.rate.average');
    expect(rateLimitProblem({ average: 1.5, burst: 10 })).toBe('proxy.rate.average');
    expect(rateLimitProblem({ average: 20, burst: 19 })).toBe('proxy.rate.burst');
    expect(rateLimitProblem({ average: 20, burst: 100_001 })).toBe('proxy.rate.burst');
  });
});

describe('additional headers', () => {
  it('are read one per line as "Name: value"', () => {
    expect(parseHeaders('X-Api-Key: abc\n\n  Authorization:Basic dXNlcjpwYXNz  \n')).toEqual({
      headers: { 'X-Api-Key': 'abc', Authorization: 'Basic dXNlcjpwYXNz' },
      problem: null,
    });
    expect(parseHeaders('')).toEqual({ headers: {}, problem: null });
    // A value may hold colons; an empty value is one too.
    expect(parseHeaders('X-Time: 12:30:00\nX-Empty:').headers).toEqual({
      'X-Time': '12:30:00',
      'X-Empty': '',
    });
    expect(headersToText({ 'X-Api-Key': 'abc', Authorization: 'x' })).toBe(
      'X-Api-Key: abc\nAuthorization: x',
    );
    expect(headersToText(null)).toBe('');
  });

  it('say which line is none, and which header the proxy keeps to itself', () => {
    expect(parseHeaders('X-Api-Key abc')).toMatchObject({
      problem: 'proxy.headers.line',
      detail: 'X-Api-Key abc',
    });
    expect(parseHeaders('Mein Kopf: 1')).toMatchObject({ problem: 'proxy.headers.line' });
    expect(parseHeaders('X-Tab: a\tb')).toMatchObject({ problem: 'proxy.headers.line' });
    for (const fixed of ['Host', 'X-Forwarded-For', 'x-velydock-user', 'Content-Length']) {
      expect(parseHeaders(`${fixed}: x`), fixed).toMatchObject({
        problem: 'proxy.headers.fixed',
        detail: fixed,
      });
    }
    expect(parseHeaders('Set-Cookie: a=b')).toMatchObject({ problem: 'proxy.headers.cookie' });
    expect(parseHeaders(`X-Long: ${'x'.repeat(1001)}`)).toMatchObject({
      problem: 'proxy.headers.long',
      detail: 'X-Long',
    });
    expect(parseHeaders(`X-Long: ${'x'.repeat(1000)}`).problem).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => `X-H${i}: 1`).join('\n');
    expect(parseHeaders(many)).toMatchObject({ problem: 'proxy.headers.many', detail: '20' });
    expect(parseHeaders(many.split('\n').slice(0, 20).join('\n')).problem).toBeNull();
  });
});

describe('what a system administrator releases', () => {
  it('is a network, an address or a host name, optionally with a port', () => {
    for (const good of [
      '10.20.0.0/16',
      '10.20.0.7',
      '10.20.0.7:8080',
      'nas.intern',
      'NAS.intern.',
      'nas.intern:8443',
      'nas',
      'fd00::/64',
      'fd00::7',
      '[fd00::7]:8080',
    ]) {
      expect(releaseProblem(good), good).toBeNull();
    }
    expect(releaseProblem('  ')).toBe('validation.required');
  });

  it('is nothing else', () => {
    for (const bad of [
      'http://10.20.0.7',
      '10.20.0.7/33',
      '10.20.0.256',
      '10.20',
      '8080',
      '10.20.0.7:0',
      '10.20.0.7:65536',
      '10.20.0.7:http',
      'nas.intern:',
      'nas intern',
      'nas.intern/app',
      '-nas.intern',
      '[fd00::7',
      '[fd00::7]8080',
      '*.intern',
    ]) {
      expect(releaseProblem(bad), bad).toBe('proxyTargets.invalid');
    }
  });
});

describe('a stored publication and what a form holds', () => {
  const stored: Publication = {
    name: 'wiki',
    mode: 'path',
    target_url: 'http://10.20.0.7:8080',
    access: 'protected',
    template: 'builtin:standard',
    options: { allow_embedding: true },
    public_url: 'https://apps.example.com/wiki/',
    problem: null,
  };
  const form = {
    name: 'wiki',
    mode: 'path',
    target_url: 'http://10.20.0.7:8080/',
    access: 'protected',
    template: 'builtin:standard',
    options: { allow_embedding: true },
  } as const;

  it('are the same publication when nothing about it differs', () => {
    // A closing slash and the case of the address are no difference.
    expect(samePublication(stored, form)).toBe(true);
    expect(samePublication(stored, { ...form, target_url: 'HTTP://10.20.0.7:8080' })).toBe(true);
  });

  it('differ by each thing a publication consists of', () => {
    expect(samePublication(stored, { ...form, name: 'wiki2' })).toBe(false);
    expect(samePublication(stored, { ...form, mode: 'subdomain' })).toBe(false);
    expect(samePublication(stored, { ...form, access: 'public' })).toBe(false);
    expect(samePublication(stored, { ...form, template: 'builtin:embeddable' })).toBe(false);
    expect(samePublication(stored, { ...form, target_url: 'http://10.20.0.8:8080' })).toBe(false);
    expect(samePublication(stored, { ...form, options: {} })).toBe(false);
    expect(samePublication(stored, { ...form, options: { allow_embedding: false } })).toBe(false);
  });
});

describe('own middlewares', () => {
  it('are kept apart from the settings of a form', () => {
    const office = { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } };
    expect(splitOptions({ allow_embedding: true, custom_middlewares: office })).toEqual({
      own: { allow_embedding: true },
      custom: office,
    });
    expect(splitOptions({ strip_prefix: false })).toEqual({
      own: { strip_prefix: false },
      custom: {},
    });
    expect(splitOptions(null)).toEqual({ own: {}, custom: {} });
    // Something that is no object of middlewares is none.
    expect(splitOptions({ custom_middlewares: ['a'] }).custom).toEqual({});
    expect(splitOptions({ custom_middlewares: null }).custom).toEqual({});
  });
});

describe('own middlewares of a template', () => {
  it('are JSON: an object of name and middleware', () => {
    const text = '{"10-buero": {"ipAllowList": {"sourceRange": ["203.0.113.0/24"]}}}';
    expect(parseMiddlewares(text)).toEqual({
      value: { '10-buero': { ipAllowList: { sourceRange: ['203.0.113.0/24'] } } },
      problem: null,
    });
    // Nothing in the field is no middleware, not a mistake.
    expect(parseMiddlewares('  \n')).toEqual({ value: {}, problem: null });
    expect(middlewaresToText({})).toBe('');
    expect(middlewaresToText(undefined)).toBe('');
    expect(JSON.parse(middlewaresToText({ a: { headers: {} } }))).toEqual({ a: { headers: {} } });
  });

  it('say whether the JSON is broken or just not an object', () => {
    const broken = parseMiddlewares('{"a": }');
    expect(broken.problem).toBe('proxy.custom.syntax');
    expect(broken.problem === null ? '' : broken.detail).not.toBe('');
    for (const other of ['[]', '"text"', '12', 'null', 'true']) {
      expect(parseMiddlewares(other).problem, other).toBe('proxy.custom.shape');
    }
  });

  it('say which name cannot be one, and where there is not exactly one middleware', () => {
    for (const name of ['Büro', '10_buero', '-buero', 'x'.repeat(32), '']) {
      expect(parseMiddlewares(JSON.stringify({ [name]: { headers: {} } })), name).toMatchObject({
        problem: 'proxy.custom.name',
        detail: name,
      });
    }
    expect(parseMiddlewares(JSON.stringify({ ['x'.repeat(31)]: { headers: {} } })).problem).toBe(
      null,
    );
    for (const definition of [{}, { headers: {}, compress: {} }, 'ipAllowList', ['a'], null]) {
      expect(
        parseMiddlewares(JSON.stringify({ '10-buero': definition })),
        JSON.stringify(definition),
      ).toMatchObject({ problem: 'proxy.custom.one', detail: '10-buero' });
    }
    const many = (count: number) =>
      JSON.stringify(
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`m${i}`, { compress: {} }])),
      );
    expect(parseMiddlewares(many(10)).problem).toBeNull();
    expect(parseMiddlewares(many(11))).toMatchObject({
      problem: 'proxy.custom.many',
      detail: '10',
    });
    expect(de('proxy.custom.name', { detail: 'Büro' })).toContain('„Büro“ kann kein Name');
  });
});

describe('templates in words', () => {
  const builtin = (key: string) => ({
    id: `builtin:${key}`,
    name: `english name of ${key}`,
    description: `english description of ${key}`,
  });

  it('names the built-in templates in the language of the page, as the manual calls them', () => {
    expect(templateText(builtin('standard'), 'name', de)).toBe('Standard');
    expect(templateText(builtin('embeddable'), 'name', de)).toBe('In Velydock einbettbar');
    expect(templateText(builtin('subpath-aware'), 'name', de)).toBe('App kennt ihren Unterpfad');
    expect(templateText(builtin('self-signed'), 'name', de)).toBe(
      'Internes Gerät mit selbstsigniertem Zertifikat',
    );
    expect(templateText(builtin('header-login'), 'name', de)).toBe('Anmeldung per Kopfzeile');
    expect(templateText(builtin('embeddable'), 'name', en)).toBe('Embeddable in Velydock');
    expect(templateText(builtin('embeddable'), 'text', de)).toContain('X-Frame-Options');
    for (const key of ['standard', 'embeddable', 'subpath-aware', 'self-signed', 'header-login']) {
      for (const part of ['name', 'text']) {
        expect(translations.de[`proxy.builtin.${key}.${part}`], key).toBeTruthy();
        expect(translations.en[`proxy.builtin.${key}.${part}`], key).toBeTruthy();
      }
    }
  });

  it('shows an own template, and a built-in one it does not know, as the server names it', () => {
    const own = { id: '7f3c', name: 'Büro-Netz', description: 'Nur aus dem Büro' };
    expect(templateText(own, 'name', de)).toBe('Büro-Netz');
    expect(templateText(own, 'text', en)).toBe('Nur aus dem Büro');
    expect(templateText(builtin('brand-new'), 'name', de)).toBe('english name of brand-new');
    expect(builtinKey('builtin:standard')).toBe('standard');
    expect(builtinKey('7f3c')).toBeNull();
  });

  it('says what a template sets, one phrase per setting', () => {
    expect(optionSummary({}, de)).toEqual([]);
    expect(optionSummary({ allow_embedding: true }, de)).toEqual(['Einbettung erlauben: an']);
    // The switch is worded the other way round than the option.
    expect(optionSummary({ verify_upstream_tls: false }, de)).toEqual([
      'Zertifikat des Ziels nicht prüfen: an',
    ]);
    expect(optionSummary({ strip_prefix: false }, en)).toEqual([
      'Remove the name from the path: off',
    ]);
    expect(
      optionSummary(
        {
          rate_limit: { average: 20, burst: 40 },
          request_headers: { 'X-Api-Key': 'abc' },
          custom_middlewares: { '20-b': {}, '10-a': {} },
        },
        de,
      ),
    ).toEqual([
      'Anfragen begrenzen: 20 pro Sekunde',
      'Zusätzliche Kopfzeilen an die Anwendung: X-Api-Key',
      'Eigene Traefik-Middlewares: 10-a, 20-b',
    ]);
  });
});

describe('why the proxy does not serve a publication', () => {
  it('has a sentence for every reason the API knows, in both languages', () => {
    for (const code of PUBLICATION_PROBLEMS) {
      expect(translations.de[`proxy.problem.${code}`], code).toBeTruthy();
      expect(translations.en[`proxy.problem.${code}`], code).toBeTruthy();
    }
    // Each says who can put it right.
    expect(de('proxy.problem.target_not_allowed')).toContain('Systemadministrator');
    expect(de('proxy.problem.template_missing')).toContain('App-Dialog');
    expect(de('proxy.problem.mode_not_allowed')).toContain('Subdomain');
  });
});
