import { apiFetch, equalsCaseInsensitive, freqControl, isEvery } from '../utils'
import { displayInterface } from '../index'
import networkForm from '../utils/networkform'
import storage from '../storage'
import parse from '../utils/parse'

type Quote = Quotes.Item

type QuotesInit = {
	sync: Sync.Storage
	local: Local.Storage
}

type QuotesUpdate = {
	toggle?: boolean
	author?: boolean
	refresh?: true
	type?: string
	url?: string
	userlist?: string
	frequency?: string
}

const quotesTypeForm = networkForm('f_qttype')
const quotesUrlForm = networkForm('f_qturl')

export default async function quotes(init?: QuotesInit, update?: QuotesUpdate) {
	if (update) {
		updateQuotes(update)
		return
	}

	if (!init) {
		return
	}

	const { lang, quotes } = init.sync
	const needsNewQuote = freqControl.get(quotes.frequency, quotes.last)

	const selection = init.local?.userQuoteSelection ?? 0
	let list = init.local?.quotesCache ?? []
	let quote: Quote = list[0]

	if (quotes.type === 'user') {
		list = csvUserInputToQuotes(quotes.userlist)
		quote = list[selection]
	} else {
		const noCache = !list || list?.length === 0

		if (noCache) {
			list = await tryFetchQuotes(lang, quotes.type, quotes.url)
			quote = list[0]
			storage.local.set({ quotesCache: list })
		}
	}

	if (needsNewQuote) {
		quotes.last = freqControl.set()
		quote = controlCacheList(list, lang, quotes.type, quotes.url)
		storage.sync.set({ quotes })
	}

	insertToDom(quote)
	toggleAuthorAlwaysOn(quotes.author)

	document.getElementById('quotes_container')?.classList.toggle('hidden', !quotes.on)

	displayInterface('quotes')
}

// ─── UPDATE

async function updateQuotes({ author, frequency, type, userlist, url, refresh }: QuotesUpdate) {
	const data = await storage.sync.get(['lang', 'quotes'])
	const local = await storage.local.get('quotesCache')

	if (author !== undefined) {
		data.quotes.author = author
		toggleAuthorAlwaysOn(author)
	}

	if (userlist) {
		data.quotes.userlist = handleUserListChange(userlist)
	}

	let updateData = false

	if (canStoreUrl(url)) {
		data.quotes.url = url
		updateData = true
	}

	if (refresh) {
		data.quotes.last = freqControl.set()
		refreshQuotes(data, local?.quotesCache)
	}

	if (isEvery(frequency)) {
		data.quotes.frequency = frequency
	}

	if (isQuotesType(type)) {
		data.quotes.type = type
		updateData = true
	}

	if (updateData) {
		updateQuotesData(data)
	}

	storage.sync.set({ quotes: data.quotes })
}

async function updateQuotesData(data: Sync.Storage) {
	const isUser = data.quotes.type === 'user'
	let list: Quote[] = []
	let selection = 0

	if (isUser && data.quotes.userlist) {
		const local = await storage.local.get('userQuoteSelection')
		selection = local?.userQuoteSelection ?? 0
		list = csvUserInputToQuotes(data.quotes.userlist)
	}

	if (!isUser) {
		const form = data.quotes.type === 'url' ? quotesUrlForm : quotesTypeForm

		try {
			form.load()
			list = await fetchQuotes(data.lang, data.quotes.type, data.quotes.url)
			form.accept()
		} catch (error) {
			form.warn('Fetch failed, please check console for further information')
			console.warn(error)
		}

		storage.local.set({ quotesCache: list })
	}

	if (list.length > 0) {
		insertToDom(list[selection])
	}

	document.getElementById('quotes_userlist')?.classList.toggle('shown', isUser)
	document.getElementById('quotes_url')?.classList.toggle('shown', data.quotes.type === 'url')
}

function handleUserListChange(input: string): string | undefined {
	let array: Quote[] = []

	if (input.length === 0) {
		return ''
	}

	// old json format
	if (input.startsWith('[[')) {
		input = oldJSONToCSV(parse<Quotes.UserInput>(input) ?? [])
	}

	array = csvUserInputToQuotes(input)

	if (array.length > 0) {
		insertToDom({
			author: array[0].author,
			content: array[0].content,
		})

		document.getElementById('i_qtlist')?.blur()
		storage.local.set({ userQuoteSelection: 0 })
	}

	return input
}

function refreshQuotes(data: Sync.Storage, list: Local.Storage['quotesCache'] = []) {
	if (data.quotes.type === 'user' && data.quotes.userlist) {
		list = csvUserInputToQuotes(data.quotes.userlist)
	}

	insertToDom(controlCacheList(list, data.lang, data.quotes.type, data.quotes.url))
}

// ─── API & STORAGE

async function fetchQuotes(lang: string, type: Quotes.Sync['type'], url: string | undefined): Promise<Quote[]> {
	if (!navigator.onLine || type === 'user') {
		return []
	}

	let response: Response | undefined

	if (type === 'url') {
		if (!url) {
			return []
		}

		response = await fetch(url)
		validateResponse(response)

		const responseType = determineUrlApiResponseType(response)

		if (responseType === 'json') {
			return await response.json()
		}

		if (responseType === 'csv') {
			return csvToQuotes(await response.text())
		}

		return []
	}

	const query = `/quotes/${type}` + (type === 'classic' ? `/${lang}` : '')

	response = await apiFetch(query)
	validateResponse(response)

	return await response.json()
}

function validateResponse(response: Response | undefined): asserts response is Response {
	if (!response) {
		throw new Error('No response')
	}

	if (!response.ok) {
		throw new Error(`Response not ok: ${response.status} ${response.statusText}`)
	}
}

async function tryFetchQuotes(lang: string, type: Quotes.Sync['type'], url: string | undefined): Promise<Quote[]> {
	try {
		return await fetchQuotes(lang, type, url)
	} catch (error) {
		console.warn(error)
	}

	return []
}

function controlCacheList(list: Quote[], lang: string, type: Quotes.Sync['type'], url: Quotes.Sync['url']): Quote {
	//
	if (type === 'user') {
		const randIndex = Math.round(Math.random() * (list.length - 1))
		storage.local.set({ userQuoteSelection: randIndex })
		return list[randIndex]
	}

	if (list.length > 1) {
		list.shift()
		storage.local.set({ quotesCache: list })
	}

	if (list.length < 2) {
		tryFetchQuotes(lang, type, url).then((list) => {
			storage.local.set({ quotesCache: list })
		})
	}

	return list[0]
}

// ─── DOM

function toggleAuthorAlwaysOn(state: boolean) {
	document.getElementById('author')?.classList.toggle('always-on', state)
}

function insertToDom(quote?: Quote) {
	const quoteDOM = document.getElementById('quote')
	const authorDOM = document.getElementById('author')

	if (!quote || !quoteDOM || !authorDOM) {
		return
	}

	quoteDOM.textContent = quote.content
	authorDOM.textContent = quote.author
}

// ─── HELPERS

function csvUserInputToQuotes(csv?: string | Quotes.UserInput): Quote[] {
	if (!csv) {
		return []
	}

	// convert <1.19.0 json format to csv
	if (Array.isArray(csv)) {
		csv = oldJSONToCSV(csv)
	}

	return csvToQuotes(csv)
}

export function oldJSONToCSV(input: Quotes.UserInput): string {
	return input.map((val) => val.join(',')).join('\n')
}

function csvToQuotes(csv: string): Quote[] {
	const rows = csv.split('\n')
	const quotes: Quote[] = []

	for (const row of rows) {
		const [author, ...rest] = row.split(',')
		const content = rest.join(',').trimStart()
		quotes.push({ author, content })
	}

	return quotes
}

function isQuotesType(type = ''): type is Quotes.Types {
	const types: Quotes.Types[] = ['classic', 'kaamelott', 'inspirobot', 'stoic', 'hitokoto', 'user', 'url']
	return types.includes(type as Quotes.Types)
}

const urlRegEx = /^https?:\/\//i

function canStoreUrl(url: string | undefined) {
	if (url === undefined) return false

	return url === '' || urlRegEx.test(url)
}

function determineUrlApiResponseType(response: Response): 'json' | 'csv' {
	const contentType = response.headers.get('content-type')?.split(';', 2)[0]

	if (contentType === 'application/json') return 'json'
	if (contentType === 'text/csv') return 'csv'

	const url = new URL(response.url)
	const parts = url.pathname.split('.')
	const extension = parts[parts.length - 1]

	if (equalsCaseInsensitive(extension, 'json')) {
		return 'json'
	}

	return 'csv'
}
