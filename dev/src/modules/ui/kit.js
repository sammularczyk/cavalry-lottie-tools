// Panel widgets styled like Easey: colours from Cavalry's theme
// so light themes work, rounded ui.Container rows with hover states, real ui.Buttons for
// actions (long work started from a Container's mouse handler has crashed Cavalry).

export function theme() {
	var pick = function (name, fallback) {
		try {
			var c = ui.getThemeColor(name)
			return typeof c === 'string' && c.charAt(0) === '#' ? c : fallback
		} catch (e) {
			return fallback
		}
	}
	var mix = function (a, b, t) {
		var ch = function (h, i) {
			return parseInt(String(h).replace('#', '').substr(i * 2, 2), 16)
		}
		var out = '#'
		for (var i = 0; i < 3; i++) {
			var v = Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)
			out += (v < 16 ? '0' : '') + v.toString(16)
		}
		return out
	}
	var bg = pick('Base', '#373737'),
		text = pick('Text', '#f1f1f1'),
		accent = pick('Accent1', '#3ddc84')
	return {
		mix: mix,
		bg: bg,
		text: text,
		accent: accent,
		surface: mix(bg, '#000000', 0.28), // recessed: lists sit sunk into the window
		raised: mix(bg, '#ffffff', 0.06), // buttons
		hover: mix(bg, text, 0.08),
		selected: mix(bg, accent, 0.22),
		muted: mix(text, bg, 0.45),
		warn: '#e8a33d',
		onAccent: '#000000',
		// list rows (Defector): text over the window, flush, split by a 1px rule in the window colour
		row: mix(bg, text, 0.1),
		rowHover: mix(bg, text, 0.16),
		detail: mix(bg, text, 0.7),
	}
}

// weight: rich text in a span (Label has no weight setter), with the text escaped
export function label(text, size, color, weight) {
	var l = new ui.Label(weight ? '<span style="font-weight:' + weight + '">' + String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' : text)
	l.setFontSize(size || 12)
	if (color) l.setTextColor(color)
	l.setTransparentForMouseEvents(true)
	return l
}

export function section(text, T) {
	return label(text.toUpperCase(), 10, T.muted, 500)
}

// Secondary: a real ui.Button with Cavalry's own outline, as on its dropdowns.
// Primary: Button can't set its text colour, so a Container + Label in the selected row's colours.
// Long work run from a Container's mouse handler has crashed Cavalry, so the press only starts a
// one-shot Timer and the work runs from that, outside the handler.
export function button(text, primary, onPress, T) {
	if (!primary) {
		var b = new ui.Button(text)
		b.setFontSize(12)
		b.setFixedHeight(26)
		b.setDrawStroke(true)
		b.setCornerRounding(4)
		b.setBackgroundColor(T.raised)
		b.onClick = function () {
			onPress()
		}
		return {
			widget: b,
			setText: function (t) {
				b.setText(t)
			},
			setEnabled: function (on) {
				b.setEnabled(!!on)
			},
		}
	}
	var l = label(text, 12, T.onAccent)
	var row = new ui.HLayout()
	row.setMargins(8, 0, 8, 0)
	row.addStretch()
	row.add(l)
	row.addStretch()
	var box = new ui.Container()
	box.setRadius(4, 4, 4, 4)
	box.setFixedHeight(26)
	box.setLayout(row)
	box.useHoverEvents(true)
	var hovered = false,
		enabled = true
	var paint = function () {
		box.setBackgroundColor(!enabled ? T.mix(T.bg, T.accent, 0.35) : hovered ? T.mix(T.accent, T.text, 0.2) : T.accent)
		l.setTextColor(T.onAccent) // after the fill: a Container's background resets its labels' colour
	}
	var timer = new api.Timer({
		onTimeout: function () {
			onPress()
		},
	})
	timer.setInterval(1)
	timer.setRepeating(false)
	box.onMouseEnter = function () {
		hovered = true
		paint()
	}
	box.onMouseLeave = function () {
		hovered = false
		paint()
	}
	box.onMousePress = function () {
		if (enabled && !timer.isActive()) timer.start()
	}
	paint()
	return {
		widget: box,
		setText: function (t) {
			l.setText(t)
		},
		setEnabled: function (on) {
			enabled = !!on
			paint()
		},
	}
}

// A list row (Defector's): title + detail over a 1px rule in the window colour, which reads as
// the gap between rows. opts: {tip, titleColor, onPress, bg, ink, icon, iconColor}: bg/ink colour
// the row and its text, icon shows on the right (selected rows show a tick instead).
export function row(title, detail, T, opts) {
	opts = opts || {}
	var ink = opts.ink || T.text,
		rowBg = opts.bg || T.row,
		mark = ICONS[opts.icon] || ICONS.preflight
	var text = new ui.VLayout()
	text.setMargins(0, 0, 0, 0)
	text.setSpaceBetween(3)
	var t = label(title, 12, opts.titleColor || ink)
	var d = detail ? label(detail, 10, T.mix(rowBg, ink, 0.7)) : null
	text.add(t)
	if (d) text.add(d)
	var tick = new ui.Draw()
	tick.setSize(mark.width, mark.height)
	tick.setTransparentForMouseEvents(true)
	var tickL = new ui.VLayout()
	tickL.setMargins(0, 0, 0, 0)
	tickL.add(tick)
	var tickHost = new ui.Container() // a Draw can't be hidden; its host can
	tickHost.setLayout(tickL)
	tickHost.setTransparentForMouseEvents(true)
	tickHost.setFixedWidth(mark.width) // a Container grows to share the row and squeezes the text
	var line = new ui.HLayout()
	line.setMargins(8, 3, 8, 3)
	line.setSpaceBetween(6)
	line.add(text) // no stretch: a squeezed Label wraps
	line.add(tickHost)
	var col = new ui.VLayout()
	col.setMargins(0, 0, 0, 0)
	col.setSpaceBetween(0)
	col.add(line)
	var rule = new ui.Container()
	rule.setBackgroundColor(T.bg)
	rule.setFixedHeight(1)
	col.add(rule)
	var box = new ui.Container()
	box.setRadius(4, 4, 4, 4)
	box.setFixedHeight(detail ? 40 : 27)
	box.setLayout(col)
	box.setToolTip(opts.tip || title)
	box.useHoverEvents(true)
	var hovered = false,
		selected = false
	var paint = function () {
		var bg = selected ? T.accent : hovered ? T.mix(rowBg, T.text, 0.07) : rowBg
		var fg = selected ? T.onAccent : ink
		box.setBackgroundColor(bg)
		t.setTextColor(selected ? fg : opts.titleColor || fg)
		if (d) d.setTextColor(T.mix(bg, fg, 0.7))
		tickHost.setHidden(!selected && !opts.icon)
		if (selected) drawIcon(tick, ICONS.preflight, fg, bg)
		else if (opts.icon) drawIcon(tick, mark, opts.iconColor || fg, bg)
	}
	box.onMouseEnter = function () {
		hovered = true
		paint()
	}
	box.onMouseLeave = function () {
		hovered = false
		paint()
	}
	if (opts.onPress) box.onMousePress = opts.onPress
	paint()
	return {
		widget: box,
		title: t,
		select: function (on) {
			selected = !!on
			paint()
		},
	}
}

// A row that switches an option on and off; on rows take the accent and a tick.
// group (a list): shift-click sets every row since the last one clicked to the same state.
export function toggleRow(title, detail, value, T, onChange, tip, group) {
	var on = !!value
	var r = row(title, detail, T, { tip: tip || detail || title })
	var self = {
		widget: r.widget,
		set: function (v) {
			on = !!v
			r.select(on)
		},
		toggle: function (v) {
			if (on === !!v) return
			self.set(v)
			onChange(on)
		},
	}
	r.widget.onMousePress = function () {
		var rows = group ? group.toggles : [],
			i = rows.indexOf(self),
			last = group ? group.last : -1
		if (group && api.isShiftHeld() && last >= 0 && last !== i) {
			var v = !on
			for (var k = Math.min(last, i); k <= Math.max(last, i); k++) rows[k].toggle(v)
		} else self.toggle(!on)
		if (group) group.last = i
	}
	r.select(on)
	if (group) group.toggles.push(self)
	return self
}

// A scrolling list of flush rows: add() rounds the first row's top corners, end() adds a filler
// that takes the empty space and the bottom corners. ScrollView takes no colour or rounding, and
// wrapping it in a Container stops it rendering, so the rows carry the surface.
export function list(height, T) {
	var l = new ui.VLayout()
	l.setMargins(0, 0, 0, 0)
	l.setSpaceBetween(0)
	var scroll = l // no height: the rows go straight in the page and the window scrolls
	if (height) {
		scroll = new ui.ScrollView()
		scroll.setLayout(l)
		scroll.setFixedHeight(height)
	}
	var count = 0,
		rows = 0,
		lastRow = null,
		lastFirst = false
	var close = function () {
		if (lastRow) lastRow.setRadius(lastFirst ? 4 : 0, lastFirst ? 4 : 0, 4, 4)
		lastRow = null
	}
	return {
		toggles: [], // toggleRows in this list, for shift-click ranges
		last: -1,
		widget: scroll,
		layout: l,
		add: function (w) {
			// a row rounds its top when it starts a run; anything else (a label) ends the run
			if (typeof w.setRadius !== 'function') {
				if (count) close() // the run ends: its last row takes the bottom corners
				count = 0
			} else {
				w.setRadius(count ? 0 : 4, count ? 0 : 4, 0, 0)
				lastRow = w
				lastFirst = !count
				count++
				rows++
			}
			l.add(w)
		},
		clear: function () {
			l.clear()
			count = rows = 0
			lastRow = null
			this.toggles = []
			this.last = -1
		},
		// fill: a filler takes the empty space below the rows (a list of options); otherwise the
		// last row takes the bottom corners and the rest stays empty
		end: function (fill) {
			if (!rows || fill === false) {
				if (count) close()
				return l.addStretch() // rows (or just a message) at the top
			}
			var filler = new ui.Container()
			filler.setBackgroundColor(T.row)
			filler.setRadius(count ? 0 : 4, count ? 0 : 4, 4, 4)
			filler.setMinimumHeight(4)
			l.add(filler)
		},
	}
}

// ---------- tab strip (Easey's segmented tabs, chrome.js) ----------
// ui.TabView can't be styled and ui.Button has no selected state or hover, so tabs are
// Containers with a drawn icon (ui.Image can't be tinted) driving a ui.PageView.

var TAB_HEIGHT = 25,
	STRIP_RADIUS = 5,
	TAB_RADIUS = 3,
	TAB_GAP = 2,
	STRIP_PADDING = 3

// Glyphs traced y-down on their own viewBox; drawn y-up via flipY.
export var ICONS = {
	export: {
		width: 12,
		height: 12,
		strokeWidth: 1.5,
		build: function (p) {
			p.moveTo(1, 7)
			p.lineTo(1, 11)
			p.lineTo(11, 11)
			p.lineTo(11, 7)
			p.moveTo(6, 8)
			p.lineTo(6, 1)
			p.moveTo(3, 4)
			p.lineTo(6, 1)
			p.lineTo(9, 4)
		},
	},
	report: {
		width: 12,
		height: 12,
		strokeWidth: 1.5,
		build: function (p) {
			p.moveTo(1, 11)
			p.lineTo(11, 11)
			p.moveTo(3, 9)
			p.lineTo(3, 5)
			p.moveTo(6, 9)
			p.lineTo(6, 2)
			p.moveTo(9, 9)
			p.lineTo(9, 6)
		},
	},
	file: {
		width: 11,
		height: 14,
		strokeWidth: 1.4,
		build: function (p) {
			p.moveTo(1, 1)
			p.lineTo(6.5, 1)
			p.lineTo(10, 4.5)
			p.lineTo(10, 13)
			p.lineTo(1, 13)
			p.lineTo(1, 1)
			p.moveTo(6.5, 1)
			p.lineTo(6.5, 4.5)
			p.lineTo(10, 4.5)
		},
	},
	warning: {
		width: 16,
		height: 16,
		strokeWidth: 1.5,
		build: function (p) {
			p.moveTo(8, 1)
			p.lineTo(15, 8)
			p.lineTo(8, 15)
			p.lineTo(1, 8)
			p.lineTo(8, 1)
			p.moveTo(8, 4.5)
			p.lineTo(8, 8.5)
			p.moveTo(8, 10.5)
			p.lineTo(8, 11.7)
		},
	},
	preflight: {
		width: 12,
		height: 12,
		strokeWidth: 1.5,
		build: function (p) {
			p.moveTo(1, 6.5)
			p.lineTo(4.5, 10)
			p.lineTo(11, 2)
		},
	},
}

function flipY(path, height) {
	return {
		moveTo: function (x, y) {
			path.moveTo(x, height - y)
		},
		lineTo: function (x, y) {
			path.lineTo(x, height - y)
		},
	}
}

// A standalone icon: a ui.Draw with ICONS[name] in color.
export function icon(name, color, background) {
	var d = new ui.Draw()
	d.setSize(ICONS[name].width, ICONS[name].height)
	d.setTransparentForMouseEvents(true)
	drawIcon(d, ICONS[name], color, background)
	return d
}

function drawIcon(canvas, icon, color, background) {
	canvas.clearPaths()
	if (background) canvas.setBackgroundColor(background)
	var path = new cavalry.Path()
	icon.build(flipY(path, icon.height))
	canvas.addPath(path.toObject(), { color: color, stroke: true, strokeWidth: icon.strokeWidth })
	canvas.redraw()
}

// tabs: [{label, icon}] -> {widget, setSelected(i)}; onSelect(i) on click
export function tabStrip(tabs, onSelect, T) {
	var trough = T.raised,
		hoverBg = T.mix(T.raised, T.surface, 0.5)
	var rowLayout = new ui.HLayout()
	rowLayout.setSpaceBetween(TAB_GAP)
	rowLayout.setMargins(STRIP_PADDING, STRIP_PADDING, STRIP_PADDING, STRIP_PADDING)
	var entries = [],
		selected = 0
	var paint = function (i) {
		var e = entries[i],
			on = i === selected
		var bg = on ? T.surface : e.hovered ? hoverBg : trough
		e.box.setBackgroundColor(bg)
		e.label.setTextColor(on ? T.text : T.muted)
		drawIcon(e.canvas, e.icon, on ? T.accent : T.muted, bg)
	}
	var paintAll = function () {
		for (var i = 0; i < entries.length; i++) paint(i)
	}
	tabs.forEach(function (tab) {
		var icon = ICONS[tab.icon]
		var canvas = new ui.Draw()
		canvas.setSize(icon.width, icon.height)
		canvas.setTransparentForMouseEvents(true)
		var l = label(tab.label, 12)
		var content = new ui.HLayout()
		content.setSpaceBetween(6)
		content.setMargins(0, 0, 0, 0)
		content.addStretch()
		content.add(canvas)
		content.add(l)
		content.addStretch()
		var box = new ui.Container()
		box.setRadius(TAB_RADIUS, TAB_RADIUS, TAB_RADIUS, TAB_RADIUS)
		box.setFixedHeight(TAB_HEIGHT)
		box.setLayout(content)
		box.useHoverEvents(true)
		entries.push({ box: box, canvas: canvas, label: l, icon: icon, hovered: false })
		rowLayout.add(box)
	})
	// second pass so each closure keeps its own index
	entries.forEach(function (e, i) {
		e.box.onMousePress = function () {
			if (i === selected) return
			selected = i
			paintAll()
			if (onSelect) onSelect(i)
		}
		e.box.onMouseEnter = function () {
			e.hovered = true
			paint(i)
		}
		e.box.onMouseLeave = function () {
			e.hovered = false
			paint(i)
		}
	})
	var strip = new ui.Container()
	strip.setBackgroundColor(trough)
	strip.setRadius(STRIP_RADIUS, STRIP_RADIUS, STRIP_RADIUS, STRIP_RADIUS)
	strip.setFixedHeight(TAB_HEIGHT + STRIP_PADDING * 2)
	strip.setLayout(rowLayout)
	paintAll()
	return {
		widget: strip,
		setSelected: function (i) {
			selected = i
			paintAll()
		},
	}
}
