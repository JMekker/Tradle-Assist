document.addEventListener("DOMContentLoaded", function () {
	
	async function initWorldGlobe(selector) {
		const dom = document.querySelector(selector);
		const chart = echarts.init(dom, null, { renderer: "canvas", useDirtyRect: false });
		const worldJson = await fetch("./data/asset/geo/world.json").then(r => r.json());
		await subsequenceNormalizeGeo(worldJson);
		echarts.registerMap("world", worldJson);
		const { lines, byName } = buildBorderLinesFromGeoJSON(worldJson);

		function inRing(lon, lat, ring) {
			let ins = false;
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const xi = ring[i][0], yi = ring[i][1];
				const xj = ring[j][0], yj = ring[j][1];
				const inter =
					((yi > lat) !== (yj > lat)) &&
					(lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
				if (inter) ins = !ins;
			}
			return ins;
		}

		function inPoly(lon, lat, poly) {
			let ins = false;
			for (const ring of poly) {
				if (inRing(lon, lat, ring)) ins = !ins;
			}
			return ins;
		}

		function inMulti(lon, lat, polys) {
			for (const poly of polys) {
				if (inPoly(lon, lat, poly)) return true;
			}
			return false;
		}

		function featureBBox(polys) {
			let minLon = Infinity, minLat = Infinity;
			let maxLon = -Infinity, maxLat = -Infinity;
			for (const poly of polys) {
				for (const ring of poly) {
					for (const [lon, lat] of ring) {
						if (lon < minLon) minLon = lon;
						if (lon > maxLon) maxLon = lon;
						if (lat < minLat) minLat = lat;
						if (lat > maxLat) maxLat = lat;
					}
				}
			}
			return [minLon, minLat, maxLon, maxLat];
		}

		function centroidOfRing(ring) {
			let a = 0, cx = 0, cy = 0;
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const x0 = ring[j][0], y0 = ring[j][1];
				const x1 = ring[i][0], y1 = ring[i][1];
				const f = x0 * y1 - x1 * y0;
				a += f;
				cx += (x0 + x1) * f;
				cy += (y0 + y1) * f;
			}
			if (Math.abs(a) < 1e-9) {
				let sx = 0, sy = 0;
				for (const [x, y] of ring) {
					sx += x;
					sy += y;
				}
				return [sx / ring.length, sy / ring.length];
			}
			a *= 0.5;
			return [cx / (6 * a), cy / (6 * a)];
		}

		function ringMidpoint(ring) {
			const i0 = 0;
			const i1 = (Math.floor(ring.length / 2)) % ring.length;
			return [(ring[i0][0] + ring[i1][0]) / 2, (ring[i0][1] + ring[i1][1]) / 2];
		}

		function bboxCenter(poly) {
			let minLon = Infinity, minLat = Infinity;
			let maxLon = -Infinity, maxLat = -Infinity;
			for (const ring of poly) {
				for (const [lon, lat] of ring) {
					if (lon < minLon) minLon = lon;
					if (lon > maxLon) maxLon = lon;
					if (lat < minLat) minLat = lat;
					if (lat > maxLat) maxLat = lat;
				}
			}
			return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
		}

		function polyContains(polys, lon, lat) {
			return (
				inMulti(lon, lat, polys) ||
				inMulti(lon + 360, lat, polys) ||
				inMulti(lon - 360, lat, polys)
			);
		}

		function interiorPointForPoly(poly) {
			const outer = poly[0] || [];

			const c1 = outer.length ? centroidOfRing(outer) : null;
			if (c1 && polyContains([poly], c1[0], c1[1])) return c1;

			const c2 = bboxCenter(poly);
			if (polyContains([poly], c2[0], c2[1])) return c2;

			const c3 = outer.length ? ringMidpoint(outer) : null;
			if (c3 && polyContains([poly], c3[0], c3[1])) return c3;

			const c4 = outer[0] || [0, 0];
			return [c4[0], c4[1]];
		}

		function largestPoly(polys) {
			let best = polys[0], bestA = -1;
			for (const poly of polys) {
				const ring = poly[0] || [];
				let a = 0;
				for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
					const x0 = ring[j][0], y0 = ring[j][1];
					const x1 = ring[i][0], y1 = ring[i][1];
					a += x0 * y1 - x1 * y0;
				}
				a = Math.abs(a * 0.5);
				if (a > bestA) {
					bestA = a;
					best = poly;
				}
			}
			return best;
		}

		function countryCenterFromFeature(f) {
			const g = f.geometry;
			if (!g) return null;
			const polys = g.type === "Polygon"
				? [g.coordinates]
				: g.type === "MultiPolygon"
				? g.coordinates
				: [];
			if (!polys.length) return null;
			const poly = largestPoly(polys);
			const p = interiorPointForPoly(poly);
			return [p[0], p[1], 0];
		}

		function buildCenterPickPoints(geo) {
			const out = [];
			for (const f of (geo.features || [])) {
				const name =
					f.properties?.name_en ||
					f.properties?.name ||
					f.properties?.NAME ||
					f.properties?.ADMIN ||
					"";
				const v = countryCenterFromFeature(f);
				if (v) out.push({ name, value: v });
			}
			return out;
		}

		function buildFloodPickPoints(geo, step = 1) {
			const out = [];
			for (const f of (geo.features || [])) {
				const name =
					f.properties?.name_en ||
					f.properties?.name ||
					f.properties?.NAME ||
					f.properties?.ADMIN ||
					"";
				const g = f.geometry;
				if (!g) continue;

				const polys =
					g.type === "Polygon"
						? [g.coordinates]
						: g.type === "MultiPolygon"
						? g.coordinates
						: [];
				if (!polys.length) continue;

				const [minLon, minLat, maxLon, maxLat] = featureBBox(polys);
				for (let lat = minLat; lat <= maxLat; lat += step) {
					for (let lon = minLon; lon <= maxLon; lon += step) {
						if (
							inMulti(lon, lat, polys) ||
							inMulti(lon + 360, lat, polys) ||
							inMulti(lon - 360, lat, polys)
						) {
							out.push({ name, value: [lon, lat, 0] });
						}
					}
				}
			}
			return out;
		}

		const initPickPoints = buildCenterPickPoints(worldJson);
		const floodPickPoints = buildFloodPickPoints(worldJson);

		const option = {
			tooltip: {
				show: true,
				formatter: p => {
					const oec = oecCache.get(p.name);
					if (!oec || !oec.data || !oec.data.length) return p.name || "";
					const top5 = [...oec.data]
						.sort((a, b) => (b["Trade Value"] || 0) - (a["Trade Value"] || 0))
						.slice(0, 5);

					const rows = top5.map(d => `
						<tr>
							<td style="padding-right:10px; text-align:left;">${d.HS4}</td>
							<td style="text-align:right;">$${Number(d["Trade Value"]).toLocaleString()}</td>
						</tr>
					`).join("");

					return `
						<div>
							<b>${p.name}</b>
							<table style="width:100%; border-collapse:collapse; margin-top:4px;">
								${rows}
							</table>
						</div>
					`;
				}
			},
			globe: {
				baseTexture: "./data/asset/geo/land_shallow_topo_10800.png",
				heightTexture: "./data/asset/geo/land_shallow_bump_5400.png",
				displacementScale: 0.05,
				shading: "realistic",
				realisticMaterial: {
					roughness: 0.8,
					metalness: 0
				},
				light: {
					main: { intensity: 0.5 },
					ambient: { intensity: 1.2 }
				},
				environment: "./data/asset/img/galactic_plane_no_nebulae_2.png",
				viewControl: {
					autoRotate: false,
					zoomSensitivity: 2,
					alpha: 20,
					beta: 90,
					minDistance: 75,
					maxDistance: 200
				}
			},
			toolbox: {
				show: true,
				left: "left",
				top: "top",
				feature: { restore: {}, saveAsImage: {} }
			},
			series: [{
				type: "lines3D",
				coordinateSystem: "globe",
				polyline: true,
				data: lines,
				progressive: 0,
				progressiveThreshold: 0,
				silent: false,
				lineStyle: { width: 1, color: "#ffffff", opacity: 0 },
				emphasis: { lineStyle: { width: 4 } }
			},
			{
				type: "scatter3D",
				coordinateSystem: "globe",
				data: initPickPoints,
				symbolSize: 5,
				itemStyle: { color: "#0078E8", opacity: .8 },
				silent: false,
				progressive: 0
			},
			{
				type: "scatter3D",
				coordinateSystem: "globe",
				data: floodPickPoints,
				symbolSize: 20,
				itemStyle: { color: "#0000ff", opacity: 0 },
				silent: false,
				progressive: 0
			}
			]
		};

		const oecCache = new Map();
		let oecPreloadPromise = null;
	
		async function fetchOECMembersMap(locale = "en") {
			const params = new URLSearchParams({ cube: "trade_i_baci_a_22", level: "Exporter Country", limit: "5000,0", locale });
			const res = await fetch(`https://api-v2.oec.world/tesseract/members?${params.toString()}`);
			if (!res.ok) throw new Error(`members HTTP ${res.status}`);
			const j = await res.json();
			const rows = j.members || j.data || [];
			const map = new Map();
			for (const r of rows) map.set((r.caption || r.name || "").trim(), r.key || null);
			console.log(map);
			return map;
		}
	
		async function fetchOECByKey(key, drilldown = "HS4", year = "2023", locale = "en") {
			if (!key) return { data: [] };
			const q = new URLSearchParams({
				cube: "trade_i_baci_a_22",
				drilldowns: drilldown,
				measures: "Trade Value",
				include: `Exporter Country:${key};Year:${year}`,
				sort: "-Trade Value",
				limit: "5000,0",
				locale
			});
			const url = `https://api-v2.oec.world/tesseract/data.jsonrecords?${q.toString()}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.json();
		}
	
		async function preloadAllOEC(byName, { drilldown = "HS4", year = "2023", locale = "en", concurrency = 8 } = {}) {
			const members = await fetchOECMembersMap(locale);
			const names = [...byName.keys()];
			console.log(byName);
			let i = 0;
			async function worker() {
				while (i < names.length) {
					const idx = i++;
					const name = names[idx];
					if (oecCache.has(name)) continue;
					const key = members.get(name) || null;
					let data = [];
					try {
						const j = await fetchOECByKey(key, drilldown, year, locale);
						data = (j.data || []).sort((a, b) => (b["Trade Value"] || 0) - (a["Trade Value"] || 0));
					} catch (e) {
						data = [];
					}
					oecCache.set(name, { key, data });
				}
			}
			const workers = Array.from({ length: Math.max(1, Math.min(concurrency, names.length)) }, worker);
			await Promise.all(workers);
		}
	
		chart.setOption(option, true);
	
		oecPreloadPromise = preloadAllOEC(byName, { drilldown: "HS4", year: "2023", locale: "en", concurrency: 8 });

		const R_KM = 6371;

		function haversineKm(a, b) {
			const toRad = Math.PI / 180;
			const lat1 = a[1] * toRad, lat2 = b[1] * toRad;
			const dLat = (b[1] - a[1]) * toRad;
			const dLon = (b[0] - a[0]) * toRad;
			const s =
				Math.sin(dLat / 2) ** 2 +
				Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
			return 2 * R_KM * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
		}

		const centerMap = new Map(initPickPoints.map(d => [d.name, d.value]));

		let selA = null, selB = null;
		let selAName = "", selBName = "";

		function updateMeasure() {
			const s = [];
			if (selA && selB) {
				s.push({ coords: [[selA[0], selA[1], 0], [selB[0], selB[1], 0]] });
			}
			chart.setOption({
				series: [{
					id: "measureLine",
					type: "lines3D",
					coordinateSystem: "globe",
					data: s,
					polyline: false,
					silent: true,
					lineStyle: { width: 3, color: "#12d7ff", opacity: 0.5 }
				}],
				graphic: selA && selB
					? [{
						id: "measureText",
						type: "text",
						left: 12,
						top: 12,
						style: {
							text: `${selAName} → ${selBName}: ${haversineKm(selA, selB).toFixed(0)} km`,
							font: "600 14px system-ui, -apple-system, Segoe UI, Roboto, Arial",
							fill: "#fff",
							lineWidth: 2,
							stroke: "#000"
						}
					}]
					: [{ id: "measureText", $action: "remove" }]
			}, false, true);
		}

		chart.on("click", p => {
			if (p.seriesType !== "scatter3D") return;
			const name = p.name || "";
			const v = centerMap.get(name) || p.value;
			if (!v) return;

			if (!selA || (selA && selB)) {
				selA = v;
				selB = null;
				selAName = name;
				selBName = "";
			} else {
				selB = v;
				selBName = name;
			}

			updateMeasure();
		});
	
		window.addEventListener("resize", chart.resize);
	}

	async function subsequenceNormalizeGeo(geo) {
		const ref = await fetch("https://cdn.jsdelivr.net/npm/world-countries@4/countries.json").then(r => r.json());

		const strip = s =>
			s?.normalize("NFD").replace(/[\u0300-\u036f]/g, "") || "";

		const letters = s =>
			strip(s).toLowerCase().replace(/[^a-z]/g, "");

		const words = s =>
			strip(s)
				.toLowerCase()
				.replace(/[^a-z\s]/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.split(" ")
				.filter(Boolean);

		const isSubseq = (a, b) => {
			let i = 0;
			for (const ch of a) {
				i = b.indexOf(ch, i);
				if (i < 0) return false;
				i++;
			}
			return true;
		};

		const uniq = arr => [...new Set(arr)];

		const cand = uniq(
			ref.flatMap(c => [c.name?.common, c.name?.official]).filter(Boolean)
		).map(x => ({
			raw: x,
			L: letters(x),
			W: words(x)
		}));

		const score = (aWords, bWords) => {
			const A = new Set(aWords);
			const B = new Set(bWords);
			let inter = 0;
			for (const t of A) if (B.has(t)) inter++;
			const jac = inter / (new Set([...A, ...B]).size || 1);
			return jac + Math.min(aWords.length, bWords.length) / Math.max(aWords.length, bWords.length, 1);
		};

		for (const f of (geo.features || [])) {
			const name =
				f.properties?.name_full ||
				f.properties?.name_en ||
				f.properties?.name ||
				f.properties?.NAME ||
				f.properties?.ADMIN ||
				"";

			const kL = letters(name);
			if (!kL) continue;

			const hits = cand.filter(c => isSubseq(kL, c.L));
			if (!hits.length) continue;

			let pick = hits[0];
			if (hits.length > 1) {
				const kW = words(name);
				pick = hits
					.map(c => [c, score(kW, c.W), c.L.length])
					.sort((a, b) => b[1] - a[1] || b[2] - a[2])[0][0];
			}

			const full = pick.raw;
			if (full) {
				f.properties.name_full = full;
				f.properties.name_en = full;
			}
		}

		return geo;
	}

	function buildBorderLinesFromGeoJSON(geo) {
		const features = geo.features || [];
		const lines = [];
		const byName = new Map();

		for (const f of features) {
			const name = f.properties?.name_full ||
				f.properties?.name_en ||
				f.properties?.name ||
				f.properties?.NAME ||
				f.properties?.ADMIN ||
				"";

			byName.set(name, f);

			const geom = f.geometry;
			if (!geom) continue;

			const polys =
				geom.type === "Polygon" ? [geom.coordinates] :
				geom.type === "MultiPolygon" ? geom.coordinates : [];

			for (const poly of polys) {
				for (const ring of poly) {
					const coords = ring.map(([lon, lat]) => [lon, lat]);
					lines.push({ name, coords });
				}
			}
		}
		return { lines, byName };
	}

	function makeCountryMaskTexture(feature, w = 4096, h = 2048) {
		const c = document.createElement("canvas");
		c.width = w; c.height = h;
		const g = c.getContext("2d");
		g.clearRect(0,0,w,h);
		g.fillStyle = "rgba(255,255,255,0.35)";
	
		const polys =
			feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] :
			feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [];
	
		for (const poly of polys) {
			g.beginPath();
			for (const ring of poly) {
				for (let i = 0; i < ring.length; i++) {
					const lon = ring[i][0], lat = ring[i][1];
					const x = (lon + 180) / 360 * w;
					const y = (90 - lat) / 180 * h;
					if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
				}
				g.closePath();
			}
			g.fill("nonzero");
		}
		return c;
	}

	initWorldGlobe('.container');

	setTimeout(() => {
			document.querySelector('.loading').style.display = 'none';
	}, 8000);

});