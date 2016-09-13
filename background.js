const MAX_CACHE_AGE = 7 * 24 * 3600 * 1000; // ms, 7 days
const REQUEST_DELAY = 200; // ms

const SITE_URL = 'https://anidb.net/';
const API_URL = SITE_URL + 'perl-bin/animedb.pl?show=json&action=search&type=%t&query=';
const SEARCH_URL = SITE_URL + 'perl-bin/animedb.pl?show=search&do.search=search&adb.search=';

const STORAGE_QUOTA = 5242880;
const CATEGORIES = {
	a: 'all',
	c: 'character',
	k: 'club',
	l: 'collection',
	r: 'creator',
	g: 'group',
	s: 'song',
	t: 'tag',
	u: 'user',
	'': 'anime'
};
const CATEGORY_SPLITTER = new RegExp('^(.*?)(?:/([' +
	Object.keys(CATEGORIES).join('') + ']))?$', 'i');

let g = {
	text: '',          // sanitized
	textForCache: '',  // sanitized with optional '/' + category 1-letter key
	textForURL: '',    // sanitized %-encoded
	category: '',      // full name of category specified after /
	siteLink: '',      // top suggestion with site search link and info

	xhrScheduled: 0,   // setTimeout id
	xhr: new XMLHttpRequest(),

	cache: chrome.storage.local,

	img: document.createElement('img'),
	canvas: document.createElement('canvas'),
	canvas2d: null,
	best: null,        // the best match to display in a notification
};
g.xhr.responseType = 'json';
g.canvas2d = g.canvas.getContext('2d');
g.img.onload = showImageNotification;

/*****************************************************************************/

chrome.omnibox.setDefaultSuggestion({description: `Open <url>${SITE_URL}</url>`});

chrome.omnibox.onInputChanged.addListener(onInputChanged);

chrome.omnibox.onInputEntered.addListener(text =>
	chrome.tabs.update({
		url: text.match(/^https?:/) ? text
		                            : text.trim() ? SEARCH_URL + g.textForURL
		                                          : SITE_URL
	}));

chrome.omnibox.onInputCancelled.addListener(abortPendingSearch);

chrome.alarms.onAlarm.addListener(alarm =>
	g.cache.remove(alarm.name));

/*****************************************************************************/

function onInputChanged(text, suggest)
{
	var m = text.trim().match(CATEGORY_SPLITTER);
	g.category = CATEGORIES[m[2] || ''];
	g.text = sanitizeInput(m[1]);
	g.textForURL = encodeURIComponent(m[1]);
	g.textForCache = 'input:' + g.text + (m[2] ? '/'+m[2] : '');

	g.siteLink = `<dim>Search for <match>${escapeXML(g.text)}</match> on site.</dim>`;
	chrome.omnibox.setDefaultSuggestion({description: g.siteLink});

	if (g.text.length < 3)
		return;

	Promise.resolve(g.textForCache)
		.then(readCache)
		.then(searchSite)
		.then(data => displayData(data, suggest));
}

function readCache(key)
{
	return new Promise(done =>
		g.cache.get(key, items => done(items[key]))
	);
}

function searchSite(data)
{
	abortPendingSearch();
	return data && data.expires > Date.now() ? data
		: new Promise(done =>
			g.xhrScheduled = setTimeout(() => {
				g.xhr.open('GET', API_URL.replace('%t', g.category) + g.textForURL);
				g.xhr.setRequestHeader('X-LControl', 'x-no-cache');
				g.xhr.onreadystatechange = () => {
					if (g.xhr.readyState == XMLHttpRequest.DONE && g.xhr.status == 200) {
						data = cookSuggestions(g.xhr.response);
						updateCache(data);
						done(data);
					}
				};
				g.xhr.send();
			}, REQUEST_DELAY)
		);
}

function updateCache(data)
{
	data.expires = Date.now() + MAX_CACHE_AGE;
	g.cache.set({[g.textForCache]: data});
	g.cache.getBytesInUse(null, size => size > STORAGE_QUOTA/2 && cleanupCache());
	chrome.alarms.create(g.textForCache, {when: data.expires});
}

function cleanupCache() {
	// remove the oldest half of the items
	g.cache.get(null, data => {
		var keys = Object.keys(data);
		keys.sort((a,b) => data[a].expires - data[b].expires);
		g.cache.remove(keys.slice(0, keys.length/2 |0));
	});
}

function displayData(data, suggest) {
	chrome.omnibox.setDefaultSuggestion({description: data.siteLink});
	suggest(data.suggestions);
	if (data.best) {
		g.img.src = data.best.image;
		g.best = data.best;
	}
}

function showImageNotification(event) {
	// skip placeholder images
	if (this.naturalWidth < 50)
		return;
	g.canvas.width = this.naturalWidth;
	g.canvas.height = this.naturalHeight;
	g.canvas2d.drawImage(this, 0, 0);
	chrome.notifications.create('best', {
		type: 'image',
		iconUrl: 'icon/256.png',
		imageUrl: g.canvas.toDataURL(),
		title: g.best.name,
		message: g.best.type,
		contextMessage: g.best.score,
	});
}

function abortPendingSearch()
{
	g.xhr.abort();
	clearTimeout(g.xhrScheduled);
}

function cookSuggestions(found)
{
	var rxWords = wordsAsRegexp(g.text, 'gi');
	var best;
	var categoryHits = {};
	return {
		suggestions: found.map(_preprocess)
			.sort((a,b) => b.weight - a.weight || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))
			.map(_formatItem),
		siteLink: g.siteLink + ' Found in categories: ' + Object.keys(categoryHits)
			.map(cat => `${cat} (${categoryHits[cat]})`).join(', '),
		best: best && {
			name: best.name,
			type: best.type,
			score: best.score,
			image: best.picurl.replace(/^[\s\S]+?https?(:.+?)thumbs\/\d+x\d+\/(.+?)-thumb[\s\S]+/,
			                          'https$1$2'),
		},
	};

	function _preprocess(item) {
		var isInCategory = g.category != 'all' || item.desc.toLowerCase().startsWith(g.category);
		var m = item.desc.match(/^(.+?), (?:Score: )?([\d.]+)[^,]*$/);
		item.type = m ? m[1] : '';
		categoryHits[item.type] = categoryHits[item.type]|0 + 1;

		var marked = item.marked = item.name.replace(rxWords, '\r$&\n');
		item.weight =  50 * (isInCategory ? 1 : 0) +
		               10 * (marked.match(/^\r|$/g).length - 1) +
		                4 * (marked.match(/ \r|$/g).length - 1) +
		                    (marked.match(/\S\r|$/g).length - 1);

		item.score = m ? m[2] : '';
		return item;
	}

	function _formatItem(item) {
		best = best || item;
		var name = reescapeXML(item.marked).replace(/\r/g, '<match>').replace(/\n/g, '</match>');
		return {
			content: item.link.startsWith('http') ? item.link : SITE_URL + item.link,
			description: `
				<dim>${item.score}</dim>&#x20;
				<url>${name}</url>
				<dim>${item.type ? ', '+item.type : ''}</dim>
			`.trim()
		};
	}

	function _dim(s) {
		return s.trim() ? `<dim>${s.trim()}</dim>` : '';
	}
}

function wordsAsRegexp(s)
{
	return new RegExp(
		s.replace(/[^\w]+/g, '|')
		 .replace(/^\||\|$/g, '')
	, 'gi');
}

function escapeXML(s)
{
	return !s || !/["'<>&]/.test(s) ? s || ''
		: s.replace(/&/g, '&amp;')
		   .replace(/"/g, '&quot;')
		   .replace(/'/g, '&apos;')
		   .replace(/</g, '&lt;')
		   .replace(/>/g, '&gt;');
}

function unescapeXML(s)
{
	return !s || !/["'<>&]/.test(s) ? s || ''
		: s
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
}

function reescapeXML(s)
{
	return escapeXML(unescapeXML(s));
}

function sanitizeInput(s)
{
	// trim punctuation at start/end, replace 2+ spaces with one space
	return s.replace(/^[!-\/:-?\[-`{-~\s]+/, '')
	        .replace(/\s{2,}/, ' ')
	        .replace(/[!-\/:-?\[-`{-~\s]+$/, '');
}
