import {init, reescapeXML, wordsAsRegexp} from './bg-search.js';

const SITE_URL = 'https://anidb.net/';

init(/** @namespace SiteState */ {
  SITE_URL,
  FETCH_OPTS: {
    headers: {'X-LControl': 'x-no-cache'},
  },
  API_URL: SITE_URL + 'perl-bin/animedb.pl?show=json&action=search&type=%t&query=',
  SEARCH_URL: SITE_URL + 'perl-bin/animedb.pl?show=search&do.search=search&adb.search=',
  CATEGORIES: {
    'a': 'all',
    'c': 'character',
    'k': 'club',
    'l': 'collection',
    'r': 'creator',
    'g': 'group',
    's': 'song',
    't': 'tag',
    'u': 'user',
    '': 'anime',
  },

  makeSearchUrl() {
    return this.SEARCH_URL + this.textForURL;
  },
  makeImageUrl(s) {
    return s?.match(/https:\/\/[^/]*?\.anidb\.net\/[-\w./?]+?(?=-thumb\.)|$/)[0];
  },
  cookSuggestions(found) {
    const {category, text} = this;
    const rxWords = wordsAsRegexp(text, 'gi');
    let best;
    const categoryHits = {};
    return /** @namespace CookedData */ {
      suggestions: found.map(_preprocess, this)
        .sort((a, b) => b.weight - a.weight || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))
        .map(_formatItem),
      siteLink: this.siteLink + ' Found in categories: ' + Object.keys(categoryHits)
        .map(cat => `${cat} (${categoryHits[cat]})`).join(', '),
      best: best && {
        title: best.name,
        text: best.type,
        note: best.score,
        image: best.picurl.replace(/^[\s\S]+?https?(:.+?)thumbs\/\d+x\d+\/(.+?)-thumb[\s\S]+/,
          'https$1$2'),
      },
    };

    function _preprocess(item) {
      const isInCategory = category !== 'all' || item.desc.toLowerCase().startsWith(category);
      const m = item.desc.match(/^(.+?), (?:Score: )?([\d.]+)[^,]*$/);
      item.type = m ? m[1] : '';
      categoryHits[item.type] = (categoryHits[item.type] | 0) + 1;

      const marked = item.marked = item.name.trim().replace(rxWords, '\r$&\n');
      item.weight = 50 * (isInCategory ? 1 : 0) +
        10 * (marked.match(/^\r|$/g).length - 1) +
        4 * (marked.match(/ \r|$/g).length - 1) +
        (marked.match(/\S\r|$/g).length - 1);

      item.score = m ? m[2] : '';
      return item;
    }

    function _formatItem(item) {
      best = best || item;
      const name = reescapeXML(item.marked).replace(/\r/g, '<match>').replace(/\n/g, '</match>');
      return {
        content: item.link.startsWith('http') ? item.link : SITE_URL + item.link,
        description:
          _dim(item.score) + '&#x20;' +
          `<url>${name}</url>` +
          _dim(item.type ? `, ${item.type}` : ''),
      };
    }

    function _dim(s) {
      s = s.trim();
      return s ? `<dim>${s}</dim>` : '';
    }
  },
});

