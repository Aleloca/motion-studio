// The SVG-edit model (SVG inner editor): colours, texts, elements and visibility inside an SVG, on an XML DOM.
export { type SvgDoc, type SvgText, type SvgElement, parseSvg, serializeSvg, elementAt, pathOf, listTexts, setText, listElements, setElementPaint, setHidden } from './tree.ts';
export { type SvgColor, COLOR_PROPS, parseColor, listColors, replaceColor } from './colors.ts';
