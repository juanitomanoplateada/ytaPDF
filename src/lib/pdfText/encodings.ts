/**
 * Simple-font encodings (PDF 32000-1, annex D) and the glyph names they use,
 * so character codes can be turned into Unicode and back.
 */

const ASCII_NAMES =
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde".split(
    " ",
  );

const LATIN1_NAMES =
  "space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis".split(
    " ",
  );

const WIN_ANSI_HIGH: Record<number, string> = {
  128: "Euro",
  130: "quotesinglbase",
  131: "florin",
  132: "quotedblbase",
  133: "ellipsis",
  134: "dagger",
  135: "daggerdbl",
  136: "circumflex",
  137: "perthousand",
  138: "Scaron",
  139: "guilsinglleft",
  140: "OE",
  142: "Zcaron",
  145: "quoteleft",
  146: "quoteright",
  147: "quotedblleft",
  148: "quotedblright",
  149: "bullet",
  150: "endash",
  151: "emdash",
  152: "tilde",
  153: "trademark",
  154: "scaron",
  155: "guilsinglright",
  156: "oe",
  158: "zcaron",
  159: "Ydieresis",
};

function buildWinAnsi(): string[] {
  const names = new Array<string>(256).fill("");
  ASCII_NAMES.forEach((name, i) => (names[32 + i] = name));
  for (const [code, name] of Object.entries(WIN_ANSI_HIGH)) names[Number(code)] = name;
  // Undefined codes in 127–160 are drawn as bullets by Acrobat.
  for (const code of [127, 129, 141, 143, 144, 157]) names[code] = "bullet";
  LATIN1_NAMES.forEach((name, i) => (names[160 + i] = name));
  return names;
}

const STANDARD_HIGH =
  "161 exclamdown 162 cent 163 sterling 164 fraction 165 yen 166 florin 167 section 168 currency 169 quotesingle 170 quotedblleft 171 guillemotleft 172 guilsinglleft 173 guilsinglright 174 fi 175 fl 177 endash 178 dagger 179 daggerdbl 180 periodcentered 182 paragraph 183 bullet 184 quotesinglbase 185 quotedblbase 186 quotedblright 187 guillemotright 188 ellipsis 189 perthousand 191 questiondown 193 grave 194 acute 195 circumflex 196 tilde 197 macron 198 breve 199 dotaccent 200 dieresis 202 ring 203 cedilla 205 hungarumlaut 206 ogonek 207 caron 208 emdash 225 AE 227 ordfeminine 232 Lslash 233 Oslash 234 OE 235 ordmasculine 241 ae 245 dotlessi 248 lslash 249 oslash 250 oe 251 germandbls";

function buildStandard(): string[] {
  const names = new Array<string>(256).fill("");
  ASCII_NAMES.forEach((name, i) => (names[32 + i] = name));
  names[39] = "quoteright";
  names[96] = "quoteleft";
  const parts = STANDARD_HIGH.split(" ");
  for (let i = 0; i < parts.length; i += 2) names[Number(parts[i])] = parts[i + 1];
  return names;
}

const MAC_ROMAN_HIGH =
  "Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron";

function buildMacRoman(): string[] {
  const names = new Array<string>(256).fill("");
  ASCII_NAMES.forEach((name, i) => (names[32 + i] = name));
  MAC_ROMAN_HIGH.split(" ").forEach((name, i) => (names[128 + i] = name));
  return names;
}

export type EncodingName = "StandardEncoding" | "WinAnsiEncoding" | "MacRomanEncoding";

export const ENCODINGS: Record<EncodingName, string[]> = {
  StandardEncoding: buildStandard(),
  WinAnsiEncoding: buildWinAnsi(),
  MacRomanEncoding: buildMacRoman(),
};

// ── Glyph names → Unicode ──────────────────────────────────────────────────

const EXTRA_NAMES =
  "quoteright 2019 quoteleft 2018 Euro 20ac quotesinglbase 201a florin 192 quotedblbase 201e ellipsis 2026 dagger 2020 daggerdbl 2021 circumflex 2c6 perthousand 2030 Scaron 160 scaron 161 guilsinglleft 2039 guilsinglright 203a OE 152 oe 153 Zcaron 17d zcaron 17e quotedblleft 201c quotedblright 201d bullet 2022 endash 2013 emdash 2014 tilde 2dc trademark 2122 Ydieresis 178 fraction 2044 fi fb01 fl fb02 ff fb00 ffi fb03 ffl fb04 dotlessi 131 dotlessj 237 Lslash 141 lslash 142 breve 2d8 dotaccent 2d9 ring 2da hungarumlaut 2dd ogonek 2db caron 2c7 minus 2212 nbspace a0 nonbreakingspace a0 sfthyphen ad softhyphen ad notequal 2260 infinity 221e lessequal 2264 greaterequal 2265 partialdiff 2202 summation 2211 product 220f pi 3c0 integral 222b Omega 3a9 radical 221a approxequal 2248 Delta 2206 lozenge 25ca apple f8ff " +
  "Amacron 100 amacron 101 Abreve 102 abreve 103 Aogonek 104 aogonek 105 Cacute 106 cacute 107 Ccircumflex 108 ccircumflex 109 Cdotaccent 10a cdotaccent 10b Ccaron 10c ccaron 10d Dcaron 10e dcaron 10f Dcroat 110 dcroat 111 Emacron 112 emacron 113 Ebreve 114 ebreve 115 Edotaccent 116 edotaccent 117 Eogonek 118 eogonek 119 Ecaron 11a ecaron 11b Gcircumflex 11c gcircumflex 11d Gbreve 11e gbreve 11f Gdotaccent 120 gdotaccent 121 Gcommaaccent 122 gcommaaccent 123 Hcircumflex 124 hcircumflex 125 Hbar 126 hbar 127 Itilde 128 itilde 129 Imacron 12a imacron 12b Ibreve 12c ibreve 12d Iogonek 12e iogonek 12f Idotaccent 130 IJ 132 ij 133 Jcircumflex 134 jcircumflex 135 Kcommaaccent 136 kcommaaccent 137 kgreenlandic 138 Lacute 139 lacute 13a Lcommaaccent 13b lcommaaccent 13c Lcaron 13d lcaron 13e Ldot 13f ldot 140 Nacute 143 nacute 144 Ncommaaccent 145 ncommaaccent 146 Ncaron 147 ncaron 148 napostrophe 149 Eng 14a eng 14b Omacron 14c omacron 14d Obreve 14e obreve 14f Ohungarumlaut 150 ohungarumlaut 151 Racute 154 racute 155 Rcommaaccent 156 rcommaaccent 157 Rcaron 158 rcaron 159 Sacute 15a sacute 15b Scircumflex 15c scircumflex 15d Scedilla 15e scedilla 15f Tcommaaccent 162 tcommaaccent 163 Tcaron 164 tcaron 165 Tbar 166 tbar 167 Utilde 168 utilde 169 Umacron 16a umacron 16b Ubreve 16c ubreve 16d Uring 16e uring 16f Uhungarumlaut 170 uhungarumlaut 171 Uogonek 172 uogonek 173 Wcircumflex 174 wcircumflex 175 Ycircumflex 176 ycircumflex 177 Zacute 179 zacute 17a Zdotaccent 17b zdotaccent 17c longs 17f Scommaaccent 218 scommaaccent 219 Tcommaaccent 21a tcommaaccent 21b " +
  "Alpha 391 Beta 392 Gamma 393 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 Chi 3a7 Psi 3a8 alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb nu 3bd xi 3be omicron 3bf rho 3c1 sigma1 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 " +
  "arrowleft 2190 arrowup 2191 arrowright 2192 arrowdown 2193 arrowboth 2194 checkmark 2713 copyrightsans f8e9 registersans f8e8 trademarksans f8ea periodcentered b7 middot b7 commaaccent f6c3 dollaroldstyle f724 centoldstyle f7a2 zerooldstyle f730 oneoldstyle f731 twooldstyle f732 threeoldstyle f733 fouroldstyle f734 fiveoldstyle f735 sixoldstyle f736 sevenoldstyle f737 eightoldstyle f738 nineoldstyle f739 onesuperior b9 twosuperior b2 threesuperior b3 degree b0 ellipsis 2026 figuredash 2012 horizontalbar 2015 underscoredbl 2017 quotereversed 201b minute 2032 second 2033 exclamdbl 203c Ifraktur 2111 weierstrass 2118 Rfraktur 211c aleph 2135 estimated 212e onethird 2153 twothirds 2154 oneeighth 215b threeeighths 215c fiveeighths 215d seveneighths 215e universal 2200 existential 2203 emptyset 2205 gradient 2207 element 2208 notelement 2209 suchthat 220b asteriskmath 2217 proportional 221d angle 2220 logicaland 2227 logicalor 2228 intersection 2229 union 222a therefore 2234 similar 223c congruent 2245 equivalence 2261 propersubset 2282 propersuperset 2283 reflexsubset 2286 reflexsuperset 2287 circleplus 2295 circlemultiply 2297 perpendicular 22a5 dotmath 22c5";

const NAME_TO_UNICODE = new Map<string, string>();

function addName(name: string, value: string): void {
  if (name && !NAME_TO_UNICODE.has(name)) NAME_TO_UNICODE.set(name, value);
}

ASCII_NAMES.forEach((name, i) => addName(name, String.fromCharCode(32 + i)));
LATIN1_NAMES.forEach((name, i) => {
  if (i > 0) addName(name, String.fromCharCode(160 + i));
});
{
  const parts = EXTRA_NAMES.split(" ");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    NAME_TO_UNICODE.set(parts[i], String.fromCodePoint(Number.parseInt(parts[i + 1], 16)));
  }
}

/**
 * Unicode for a glyph name: Adobe Glyph List names, `uniXXXX`, `uXXXX`,
 * suffixed variants (`a.sc`) and ligatures written with underscores (`f_i`).
 */
export function glyphNameToUnicode(name: string): string | undefined {
  const direct = NAME_TO_UNICODE.get(name);
  if (direct !== undefined) return direct;

  const base = name.split(".")[0];
  if (base !== name && base) return glyphNameToUnicode(base);
  if (base.includes("_")) {
    const parts = base.split("_").map((part) => glyphNameToUnicode(part));
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
  }

  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (uni) {
    let out = "";
    for (let i = 0; i < uni[1].length; i += 4) {
      const value = Number.parseInt(uni[1].slice(i, i + 4), 16);
      if (value >= 0xd800 && value <= 0xdfff) return undefined;
      out += String.fromCharCode(value);
    }
    return out;
  }
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) {
    const value = Number.parseInt(u[1], 16);
    return value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : undefined;
  }
  return undefined;
}

/** Inverse of {@link glyphNameToUnicode} for the names the tables know. */
export function unicodeToGlyphName(text: string): string | undefined {
  for (const [name, value] of NAME_TO_UNICODE) if (value === text) return name;
  const cp = text.codePointAt(0);
  if (cp === undefined || [...text].length !== 1) return undefined;
  return cp <= 0xffff ? `uni${cp.toString(16).toUpperCase().padStart(4, "0")}` : `u${cp.toString(16).toUpperCase()}`;
}
