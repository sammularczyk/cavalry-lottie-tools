// Panel widgets styled like Easey / Defector (ae-to-cavalry): colours from Cavalry's theme
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
	}
}

export function label(text, size, color) {
	var l = new ui.Label(text)
	l.setFontSize(size || 12)
	if (color) l.setTextColor(color)
	l.setTransparentForMouseEvents(true)
	return l
}

export function section(text, T) {
	return label(text.toUpperCase(), 10, T.muted)
}

// A real ui.Button, styled with what Button allows: fill, rounding, no stroke.
export function button(text, primary, onPress, T) {
	var b = new ui.Button(text)
	b.setFontSize(12)
	b.setFixedHeight(26)
	b.setDrawStroke(false)
	b.setCornerRounding(4)
	b.setBackgroundColor(primary ? T.mix(T.bg, T.accent, 0.55) : T.raised)
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

// A two-line row (title + muted detail). opts: {tip, titleColor, onPress}
export function row(title, detail, T, opts) {
	opts = opts || {}
	var col = new ui.VLayout()
	col.setMargins(8, 4, 8, 4)
	col.setSpaceBetween(1)
	var t = label(title, 12, opts.titleColor || T.text)
	col.add(t)
	if (detail) col.add(label(detail, 10, T.muted))
	var box = new ui.Container()
	box.setRadius(4, 4, 4, 4)
	box.setFixedHeight(detail ? 38 : 26)
	box.setLayout(col)
	box.setToolTip(opts.tip || title)
	box.useHoverEvents(true)
	var hovered = false,
		selected = false
	var paint = function () {
		box.setBackgroundColor(selected ? T.selected : hovered ? T.hover : T.surface)
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

// A row that switches an option on and off; on rows take the selected colour and a tick.
export function toggleRow(title, detail, value, T, onChange, tip) {
	var on = !!value
	var r = row('', detail, T, { tip: tip || detail || title })
	var paint = function () {
		r.title.setText((on ? '✓  ' : '     ') + title)
		r.select(on)
	}
	r.widget.onMousePress = function () {
		on = !on
		paint()
		onChange(on)
	}
	paint()
	return {
		widget: r.widget,
		set: function (v) {
			on = !!v
			paint()
		},
	}
}

// A recessed scrolling list. ScrollView sizes itself; wrapping it in a Container stops it rendering.
export function list(height, T) {
	var l = new ui.VLayout()
	l.setMargins(4, 4, 4, 4)
	l.setSpaceBetween(2)
	var scroll = new ui.ScrollView()
	scroll.setLayout(l)
	scroll.setFixedHeight(height)
	return { widget: scroll, layout: l }
}
