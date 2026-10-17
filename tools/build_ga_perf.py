"""Build data/ga_perf.json: XPerf's own GA / turboprop / business-jet performance table.

Every number comes from an independent public source (manufacturer spec pages and brochures,
POH/AFM figures, magazine "standard data" pages that reproduce manufacturer figures, or compiled
reference pages) or is marked as estimated with the method stated. No EUROCONTROL data is used.

Edit the TYPES table below, then run:  python tools/build_ga_perf.py
Check the result with:                   python tools/validate_ga_perf.py

Value status codes (see SCHEMA below):
  pub  published figure, read online from the cited source on CHECKED (directly or via a search
       engine's summary of that page)
  rec  published figure attributed to the cited document, from recall, NOT re-read online — verify
  der  derived arithmetically from sourced values (method stated)
  est  estimate (method stated, no source)
"""
import json, os

CHECKED = "2026-10-16"
LB, FT, LBF = 0.45359237, 0.3048, 0.00444822   # lb->kg, ft->m, lbf->kN
AVGAS_KG_GAL, JET_KG_GAL, JET_KG_L = 2.72, 3.04, 0.803   # 6.0 lb/gal avgas, 6.7 lb/gal Jet A

# ----------------------------------------------------------------------------------------------
# Sources. kind: manufacturer | poh | magazine | reference | aggregator  (weakest last)
# ----------------------------------------------------------------------------------------------
def S(title, publisher, year, kind, url=None, note=None):
    d = {"title": title, "publisher": publisher, "year": year, "kind": kind}
    if url: d["url"] = url
    if note: d["note"] = note
    return d

SOURCES = {
 # --- manufacturers -------------------------------------------------------------------------
 "tx_skyhawk": S("Cessna Skyhawk – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/piston/cessna-skyhawk"),
 "tx_skylane": S("Cessna Skylane – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/piston/cessna-skylane"),
 "tx_t206hd": S("Cessna Turbo Stationair HD – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/piston/cessna-turbo-stationair-hd"),
 "tx_gcex": S("Cessna Grand Caravan EX – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/turboprop/grand-caravan-ex"),
 "tx_m2": S("Cessna Citation M2 Gen2 – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/citation/m2-gen2"),
 "tx_cj3": S("Cessna Citation CJ3 Gen3 – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/citation/cj3-gen3"),
 "tx_xls": S("Cessna Citation XLS Gen2 – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://cessna.txtav.com/en/citation/xls-gen2"),
 "tx_ka260": S("Beechcraft King Air 260 – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://beechcraft.txtav.com/en/king-air-260"),
 "tx_ka360": S("Beechcraft King Air 360 – specifications", "Textron Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://beechcraft.txtav.com/en/king-air-360"),
 "piper_archer_lx": S("Piper Archer LX – model page", "Piper Aircraft", "web page, accessed 2026-10-16", "manufacturer", "https://www.piper.com/model/archer-lx/"),
 "piper_seminole": S("Piper Seminole – model page", "Piper Aircraft", "web page, accessed 2026-10-16", "manufacturer", "https://www.piper.com/model/seminole/"),
 "piper_m350": S("Piper M350 – model page and 2023 M350 spec sheet", "Piper Aircraft", "2023 / accessed 2026-10-16", "manufacturer", "https://www.piper.com/wp-content/uploads/2023/01/2023_M350-Single-Spec-Sheet.pdf"),
 "diamond_da40": S("Diamond DA40 series – tech specs (DA40 NG column)", "Diamond Aircraft", "web page, accessed 2026-10-16", "manufacturer", "https://www.diamondaircraft.com/en/private-owners/aircraft/da40/tech-specs/"),
 "diamond_da42": S("Diamond DA42 – tech specs", "Diamond Aircraft", "web page, accessed 2026-10-16", "manufacturer", "https://www.diamondaircraft.com/en/private-owners/aircraft/da42/tech-specs/"),
 "diamond_da50": S("Diamond DA50 RG – tech specs (as relayed by Aviatize, GlobalAir and the 2020 preliminary facts & specifications)", "Diamond Aircraft", "2020–2026", "reference", "https://www.aviatize.com/aircraft/diamond-da50-rg", "Diamond's own page could not be fetched; figures read from secondary pages quoting it"),
 "pilatus_pc12ngx": S("Pilatus PC-12 NGX factsheet", "Pilatus Aircraft Ltd", "factsheet, accessed 2026-10-16", "manufacturer", "https://www.pilatus-aircraft.com/data/document/Pilatus-Aircraft-Ltd-PC-12NGX-Factsheet.pdf"),
 "embraer_p100ex": S("Phenom 100EX brochure", "Embraer", "2023", "manufacturer", "https://www.embraer.com/media/rkym1sp4/phenom-100ex-brochure-final.pdf"),
 "embraer_p300e": S("Phenom 300E brochure", "Embraer", "2025", "manufacturer", "https://www.embraer.com/media/kvajetsu/114-2025-brochure-phenom-300e-17-fb-eletronic-low.pdf"),
 "honda_perf": S("HondaJet Elite II – performance", "Honda Motor Co.", "web page, accessed 2026-10-16", "manufacturer", "https://global.honda/products/HondaJet/performance.html"),
 "bbd_cl350": S("Challenger 350 factsheet", "Bombardier", "2020", "manufacturer", "https://bombardier.com/sites/default/files/2020-07/Bombardier_Factsheets2020_350_En.pdf"),
 "bbd_g6000": S("Global 6000 specification sheet / Bombardier Defense Global 6000 page", "Bombardier", "accessed 2026-10-16", "manufacturer", "https://defense.bombardier.com/en/node/51"),
 "dassault_2000lxs": S("Falcon 2000LXS – key figures", "Dassault Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://www.dassault-aviation.com/en/civil/falcon-family/falcon-2000lxs"),
 "dassault_900lx": S("Falcon 900LX – key figures", "Dassault Aviation", "web page, accessed 2026-10-16", "manufacturer", "https://www.dassault-aviation.com/en/civil/falcon-family/falcon-900lx"),
 "piaggio_evo": S("Avanti EVO – specifications", "Piaggio Aerospace", "web page, accessed 2026-10-16", "manufacturer", "https://avantievo.piaggioaerospace.it"),
 # --- POH / information manuals --------------------------------------------------------------
 "poh_c172s": S("Cessna Model 172S Pilot's Operating Handbook", "Cessna Aircraft Co.", "8 July 1998 (with revisions)", "poh", "https://www.befa.org/wp-content/uploads/2019/12/POH-Cessna-172S.pdf"),
 "poh_c150m": S("Cessna 1977 Model 150M Commuter Pilot's Operating Handbook", "Cessna Aircraft Co.", "1976", "poh", "https://res.cloudinary.com/absoluttweb/image/upload/bak/CESSNA_150_POH_bxx539.pdf", "scanned; figures read via a search summary of the performance-specifications page"),
 "im_c152": S("Cessna Model 152 Information Manual", "Cessna Aircraft Co.", "1980", "poh", "https://www.touringmachine.com/PDFs-Txt/Cessna-152_POH.pdf", "scanned; figures read via a search summary of the performance-specifications page"),
 # --- magazines (secondary; usually reproduce manufacturer standard data) ---------------------
 "pp_c207": S("Cessna 'Stationair 8' / 'Skywagon' 207 – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/cessna-stationair-8-7-skywagon-207/"),
 "pp_t210n": S("1981 Cessna Centurion T210N – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/1981-cessna-centurion-t-210-n-n104sc-2/"),
 "pp_c23": S("Beechcraft 1975 C23 Sundowner – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/beechcraft-1975-c23-sundowner/"),
 "aopa_c23": S("Beechcraft Sundowner fact sheet", "AOPA", "web page, accessed 2026-10-16", "magazine", "https://aopa.org/go-fly/aircraft-and-ownership/aircraft-fact-sheets/beechcraft-sundowner"),
 "pp_b55": S("Beechcraft 1980 B55 Baron – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/beechcraft-1980-b55-baron/"),
 "pp_be76": S("Beech 76 'Duchess' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/beech-76-duchess/"),
 "pp_g36": S("2017 Beechcraft Bonanza G36 – specifications (Beechcraft data)", "Plane & Pilot", "2017", "magazine", "https://planeandpilotmag.com/2017-beechcraft-bonanza-g36/"),
 "pp_g58": S("2008 Beechcraft Baron G58 – specifications (Hawker Beechcraft data)", "Plane & Pilot", "2008", "magazine", "https://planeandpilotmag.com/2008-beechcraft-baron-g58/"),
 "aopa_g58": S("Beechcraft Baron – aircraft guide", "AOPA", "web page, accessed 2026-10-16", "magazine", "https://www.aopa.org/go-fly/aircraft-and-ownership/aircraft-guide/aircraft/beechcraft-baron"),
 "aopa_310r": S("Cessna 310R – aircraft guide", "AOPA", "web page, accessed 2026-10-16", "magazine", "https://www.aopa.org/go-fly/aircraft-and-ownership/aircraft-guide/aircraft/cessna-310r"),
 "pp_337": S("Cessna 336/337 'Skymaster' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/cessna-336-337-skymaster-pressurized-skymaster/"),
 "fo_337": S("337 Skymaster owners forum – 1977 337G POH performance summary", "337skymaster.com", "forum post", "reference", "https://www.337skymaster.com/messages/showthread.php?p=1577"),
 "aopa_340": S("Cessna 340 fact sheet", "AOPA", "web page, accessed 2026-10-16", "magazine", "https://aopa.org/go-fly/aircraft-and-ownership/aircraft-fact-sheets/cessna-340"),
 "pp_340": S("Cessna 340 – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/cessna-340/"),
 "pp_402": S("Cessna 402 – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://www.planeandpilotmag.com/?p=15228"),
 "pp_414": S("Cessna 411/414 Chancellor – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/cessna-411414-chancellor/"),
 "pp_421": S("Cessna 421 'Golden Eagle' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/cessna-421-golden-eagle-2/"),
 "pp_archer3": S("Piper 1999 PA-28-181 Archer III – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/piper-1999-pa-28-181-archer-iii"),
 "pp_turbo_arrow": S("Piper 1978 PA-28R-201T Turbo Arrow III – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/piper-1978-pa-28r-201t-turbo-arrow-iii"),
 "pp_pa32": S("Piper 1972 PA-32-300 Cherokee Six – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/piper-1972-pa-32-300-cherokee-six/"),
 "pp_seneca5": S("2007 Piper PA34-220T Seneca V – specifications", "Plane & Pilot", "2007", "magazine", "https://planeandpilotmag.com/2007-piper-pa34-220t-seneca-v/"),
 "pp_aztec": S("Piper Aztec – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/article/piper-aztec/"),
 "pp_apache": S("Piper Apache 160 – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://www.planeandpilotmag.com/?p=14969"),
 "pp_pa18": S("Piper PA-18 'Super Cub' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/piper-pa-18-super-cub/"),
 "pp_pa38": S("Piper 'Tomahawk' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/scroll/piper-tomahawk/"),
 "pp_pa44": S("Piper 1979 PA-44-180 Seminole – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/piper-1979-pa-44-180-seminole/"),
 "pp_m600": S("Piper PA-46 M600 – specifications", "Plane & Pilot", "2016", "magazine", "https://planeandpilotmag.com/piper-pa-46-m600-specifications/"),
 "pp_meridian": S("Piper PA-46 Meridian – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/?p=13446"),
 "aopa_m350": S("Piper M350 – aircraft guide (manufacturer's calculations)", "AOPA", "web page, accessed 2026-10-16", "magazine", "https://aopa.org/go-fly/aircraft-and-ownership/aircraft-guide/aircraft/piper-m350"),
 "pp_da42": S("Diamond DA42-VI – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/diamond-da42-vi/"),
 "pp_tb20": S("Socata 1998 TB-20 Trinidad – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/socata-1998-tb-20-trinidad/"),
 "pp_acclaim": S("Mooney Acclaim Type S – specifications", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/mooney-acclaim-type-s-still-the-fastest/"),
 "pp_rallye": S("Socata 'Rallye' / Waco 'Minerva' – standard data", "Plane & Pilot", "undated web archive", "magazine", "https://planeandpilotmag.com/article/socata-rallye-waco-minerva/"),
 "bjt_c90gtx": S("Beechcraft King Air C90GTx – specifications", "Business Jet Traveler", "web page, accessed 2026-10-16", "magazine", "https://www.bjtonline.com/aircraft/beechcraft-king-air-c90gtx"),
 "aopa_lj60xr": S("Turbine Pilot: Learjet 60XR", "AOPA Pilot", "November 2008", "magazine", "https://www.aopa.org/news-and-media/all-news/2008/november/pilot/turbine-pilot-learjet-60xr-bring-it-on"),
 "aopa_premier": S("Beechcraft Premier 1A (spec box)", "AOPA Pilot", "February 2007", "magazine", "https://www.aopa.org/news-and-media/all-news/2007/february/01/beechcraft-premier-1a"),
 "ain_2000lxs": S("Dassault introduces Falcon 2000LXS", "AIN", "29 Oct 2012", "magazine", "https://ainonline.com/aviation-news/2012-10-29/dassault-introduces-2000lxs"),
 "avweek_p300e": S("Aircraft Overview: Phenom 300E", "Aviation Week", "web page, accessed 2026-10-16", "magazine", "https://aviationweek.com/business-aviation/aircraft-overview/aircraft-overview-phenom-300e"),
 "avweek_sov": S("Aircraft Overview: Citation Sovereign", "Aviation Week", "web page, accessed 2026-10-16", "magazine", "https://aviationweek.com/business-aviation/aircraft-overview/aircraft-overview-citation-sovereign"),
 "pilot_sr22": S("Cirrus SR22: the complete guide (figures attributed to the Cirrus POH)", "Rotate Pilot", "web page, accessed 2026-10-16", "reference", "https://www.rotatepilot.com/guides/cirrus-sr22-guide"),
 # --- compiled reference pages (secondary) ---------------------------------------------------
 "cf_177b": S("Cardinal 177B (1975–78) performance specifications", "Cardinal Flyers Online (owners' association)", "web page, accessed 2026-10-16", "reference", "https://www.cardinalflyers.com/prep/specs/177b2.php"),
 "aero_c421": S("Cessna 421 Golden Eagle", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/?p=11099"),
 "aero_c414": S("Cessna 414 Chancellor", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/cessna-414-chancellor/"),
 "aero_tb9": S("Socata TB-9 Tampico / TB-10 Tobago", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/socata-tb-9-tampico-and-tb-10-tobago/"),
 "aero_tb20": S("Socata TB-20 Trinidad", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/?p=4317"),
 "aero_dr400": S("Robin DR 400 Regent", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/robin-dr-400-regent/"),
 "fi_dr400": S("Robin DR.400 data sheet", "flugzeuginfo.net", "web page, accessed 2026-10-16", "reference", "https://www.flugzeuginfo.net/acdata_php/acdata_robindr400_en.php"),
 "aero_pa38": S("Piper PA-38 Tomahawk", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/piper-pa-38-tomahawk/"),
 "aero_dhc6": S("de Havilland Canada DHC-6 Twin Otter", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/?p=3388"),
 "aero_meridian": S("Piper PA-46-500TP Malibu Meridian", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/piper-pa-46-500tp-malibu-meridian/"),
 "aero_tbm850": S("Socata TBM 850", "Aeropedia (Australia)", "web page, accessed 2026-10-16", "reference", "https://aeropedia.com.au/content/socata-tbm-850/"),
 "fi_c425": S("Cessna 425 Corsair & Conquest I data sheet", "flugzeuginfo.net", "web page, accessed 2026-10-16", "reference", "https://www.flugzeuginfo.net/acdata_php/acdata_cessna425_en.php"),
 "fi_c441": S("Cessna 441 Conquest II data sheet", "flugzeuginfo.net", "web page, accessed 2026-10-16", "reference", "https://www.flugzeuginfo.net/acdata_php/acdata_cessna441_en.php"),
 "fg_pc6": S("Pilatus PC-6 Turbo Porter flight test (via Military Wiki / Hartzell)", "FlightGlobal (as quoted)", "accessed 2026-10-16", "reference", "https://military-history.fandom.com/wiki/Pilatus_PC-6_Porter"),
 "skybrary": S("SKYbrary aircraft type pages", "SKYbrary / EUROCONTROL-ICAO-Flight Safety Foundation", "accessed 2026-10-16", "reference", "https://skybrary.aero/aircraft/rall", "used for wingspan only"),
 "jetcraft": S("Jetcraft product overviews (Challenger 605, Citation X, Learjet 60XR, Falcon 7X, Sovereign)", "Jetcraft", "2015–2024", "reference", "https://www.jetcraft.com/jetstream/2018/04/cessna-citation-x-overview-1995-2012/", "broker overviews that state SL/ISA/MTOW conditions"),
 "wiki_types": S("Wikipedia type articles (specification boxes, citing manufacturer data)", "Wikipedia", "accessed 2026-10-16", "reference", "https://en.wikipedia.org/wiki/Cessna_421"),
 "fr_lj45": S("Learjet 45 – specifications", "FlyRadius", "web page, accessed 2026-10-16", "aggregator", "https://www.flyradius.com/bombardier-learjet-45/specifications"),
 "fr_acclaim": S("Mooney Acclaim Type S – performance", "FlyRadius", "web page, accessed 2026-10-16", "aggregator", "https://www.flyradius.com/mooney-acclaim-type-s/performance"),
 # --- aggregators (weakest; disclaimers say "not for flight planning") -------------------------
 "ga": S("GlobalAir.com aircraft specifications pages", "GlobalAir.com", "accessed 2026-10-16", "aggregator", "https://www.globalair.com/aircraft-specifications/", "one page per type; GlobalAir states its data may be inaccurate"),
 "rr_cj2": S("Cessna Citation CJ2 – specifications", "RocketRoute / Jetcraft / SkyAccess (CJ2+)", "accessed 2026-10-16", "aggregator", "https://www.rocketroute.com/aircraft/cessna-citation-cj2"),
 "aggr_misc": S("Misc. secondary spec pages (aerocorner, aviatize, jettly, aircraftcostcalculator, guardianjet, jetvip)", "various", "accessed 2026-10-16", "aggregator", None, "cited only where nothing better was found; see per-value ref"),
}

# ----------------------------------------------------------------------------------------------
# Value constructors
# ----------------------------------------------------------------------------------------------
def P(v, u, src, ref):  return ("pub", v, u, src, ref)
def R(v, u, src, ref):  return ("rec", v, u, src, ref)
def E(v, u, method):    return ("est", v, u, None, method)
def D(v, u, src, method): return ("der", v, u, src, method)

def conv(v, u, target):
    if target == "kg":   return round(v * LB) if u == "lb" else round(v)
    if target == "m":    return round(v * FT) if u == "ft" else round(v, 2) if v < 100 else round(v)
    if target == "kN":   return round(v * LBF, 2) if u == "lbf" else round(v, 2)
    if target == "hft":  return round(v / 100)              # ceiling in hundreds of feet
    if target == "span": return round(v * FT, 2) if u == "ft" else round(v, 2)
    return v

def obj(t, target=None):
    st, v, u, src, ref = t
    o = {"v": conv(v, u, target) if target else v, "s": st}
    if src: o["src"] = src if isinstance(src, list) else [src]
    if st in ("pub", "rec"):
        o["ref"] = ref + (f" [{v:,} {u}]" if target in ("kg", "m", "kN", "span") and u not in ("kg", "m", "kN") else "")
    else:
        o["method"] = ref
    return o

def r5(x): return int(5 * round(x / 5))
def r10(x): return int(10 * round(x / 10))
def r50(x): return int(50 * round(x / 50))
def r100(x): return int(100 * round(x / 100))

A_TROP = 573.6   # speed of sound (kt) in the ISA stratosphere (>= 36,089 ft)

# ----------------------------------------------------------------------------------------------
# Estimation rules (one place, so methods are consistent). IDs are referenced from the schema.
# ----------------------------------------------------------------------------------------------
RULES = {
 "VAT":   "landingVat ≈ 1.3 × Vso (published landing-configuration stall speed); the FAR/CS-23 VREF definition",
 "V50":   "takeOffV2 (speed at 50 ft) ≈ 1.2 × Vso; FAR/CS-23 minimum speed at 50 ft is 1.2 × VS1",
 "VY":    "initialClimbIAS ≈ 1.55 × Vso (Vy/Vso ratio of the C172S 1.54 and C182T 1.63 from their POHs)",
 "APP":   "approachIAS ≈ 1.5 × Vso, rounded to 5 kt (flaps-up/initial approach; C172S POH gives 65–75 KIAS = 1.35–1.56 Vso)",
 "APPJ":  "approachIAS ≈ Vref + 40 kt (speed typically flown ~3,000 ft AGL before final flap)",
 "APPROD": "approachROD ≈ 5.3 × approachIAS (3° glide path: fpm ≈ 101.3 × kt × tan 3°), rounded to 50",
 "DESIAS": "descentIAS ≈ the larger of cruise IAS (cruise TAS / (1 + 0.02 × cruise altitude in thousands of ft)) and 0.75 × cruise TAS, rounded to 5 kt — high-flying turboprops/turbo pistons descend faster than their cruise IAS",
 "DESIASJ": "descentIAS: 250 KIAS for light jets (MTOW ≤ 7,000 kg, Vmo ≈ 260–280), 280 KIAS otherwise (typical business-jet descent schedule)",
 "DESROD": "descentROD by class: 500 fpm unpressurized piston (the descent-chart assumption in Piper/Mooney POHs), 1,000 fpm pressurized piston or unpressurized turboprop, 1,500 fpm pressurized turboprop, 2,500 fpm jet",
 "JCLIMB": "jet climb schedule: initial climb 200 KIAS, 250 KIAS to FL150 and FL240 (ICAO/FAA 250 kt limit below FL100, commonly held to the Mach transition), Mach climb at cruise Mach − 0.05",
 "JROC":  "jet climb rates as fractions of the sea-level climb rate: 0.8 to FL150, 0.5 to FL240, 0.25 above FL240 — calibrated so the Citation XLS Gen2 (4,400 fpm est. at SL) reproduces Textron's published 26 min direct climb to FL430",
 "JROC0": "jet sea-level climb rate ≈ 10,600 fpm × (total thrust / MTOW); ratio calibrated on the published rates of the CJ3 Gen3 (4,478), M2 Gen2 (3,698) and HondaJet Elite II (4,100)",
 "TPCLIMB": "turboprop cruise-climb IAS ≈ 1.3 × initialClimbIAS; climb rate 0.85 × sea-level rate to FL150 and 0.65 × to FL240 (flat-rated PT6/TPE331 power holds into the mid-teens)",
 "JDES":  "initialDescentMACH = cruise Mach; initialDescentROD = descentROD",
 "V2J":   "takeOffV2 ≈ Vref + 5 kt (V2 at MTOW ≈ 1.13 VSR in take-off flap; Vref = 1.23 VSR at the lower landing weight)",
 "VREFJ": "Vref at typical landing weight as reported in public pilot reports / operator data for the type; ±10 kt",
 "RANGE": "cruiseRange ≈ 4.5 h × cruise TAS (typical full-fuel endurance less reserve for GA types); no published range found",
 "TOGR":  "takeOffDistance (to 50 ft) ≈ ground roll × 1.7 (pistons) or × 1.4 (turboprops) — ratios of sourced types in this table (C172S 1.70, C182T 1.90, T206H 1.86, C23 1.73; King Air 260 1.23, Grand Caravan EX 1.54)",
 "LDGGR": "landingDistance (from 50 ft) ≈ ground roll × 2.3 (pistons) or × 1.8 (turboprops) — ratios of sourced types in this table (C172S 2.32, C182T 2.29, T206H 1.90, C23 2.11; King Air 260 1.63, Grand Caravan EX 1.83)",
 "MACH":  "cruiseMACH = cruise TAS / 573.6 kt (speed of sound at or above 36,089 ft ISA) unless a cruise altitude is stated",
 "TAS":   "cruiseTAS = cruise Mach × 573.6 kt (ISA at or above 36,089 ft)",
 "WTC":   "wtc from MTOW: L ≤ 7,000 kg, M above (ICAO Doc 8643 wake categories)",
 "DESIG": "type designator description from the engine count and kind: L<n>P/T/J (landplane)",
}

# methods name the rule id; the rule text lives once in _schema.rules
def est(v, rule): return {"v": v, "s": "est", "method": f"[{rule}]"}
def der(v, src, rule, extra=""): return {"v": v, "s": "der", "src": src if isinstance(src, list) else [src], "method": f"[{rule}]" + (f" {extra}" if extra else "")}

# ----------------------------------------------------------------------------------------------
# Aircraft table. Keys:
#  name, variant, kind (piston|turboprop|jet), n, eng (power tuple: hp per engine, or lbf/kN
#  thrust per engine), fuel (avgas|jet-a), turbo, diesel, press, span, mtow, ceil, roc, vy,
#  tas (+ cruise dict), mach, rng, to, ldg, to_gr, ldg_gr, vso, v50, vat, app, vref, ff, notes
# ----------------------------------------------------------------------------------------------
G = "ga"
TYPES = {}
def T(code, **k): TYPES[code] = k

# ======================= single-engine piston ===============================================
T("C150", name="Cessna 150", variant="150M Commuter (1975–77), Continental O-200-A 100 hp", kind="piston", n=1, fuel="avgas",
  eng=R(100, "hp", "poh_c150m", "Continental O-200-A, 100 BHP"),
  span=R(32.71, "ft", "poh_c150m", "wing span 32 ft 8.5 in"),
  mtow=R(1600, "lb", "poh_c150m", "maximum weight 1,600 lb"),
  ceil=R(12650, "ft", "poh_c150m", "service ceiling 12,650 ft"),
  roc=R(670, "fpm", "poh_c150m", "rate of climb at sea level 670 fpm"),
  tas=P(106, "kt", "poh_c150m", "cruise, 75% power at 7,000 ft: 106 kt"), cruise={"power": "75%", "alt_ft": 7000},
  rng=P(340, "nm", "poh_c150m", "range 340 NM (22.5 gal usable, 75% at 7,000 ft, 45-min reserve); 580 NM with 35 gal long-range tanks"),
  to=P(1385, "ft", "poh_c150m", "total distance over 50-ft obstacle 1,385 ft (ground roll 735 ft)"),
  ldg=R(1075, "ft", "poh_c150m", "total distance over 50-ft obstacle 1,075 ft (ground roll 445 ft)"),
  vso=R(42, "kt", "poh_c150m", "stall speed flaps down, power off 42 KCAS"))

T("C152", name="Cessna 152", variant="152 (1978–85), Lycoming O-235-L2C 110 hp", kind="piston", n=1, fuel="avgas",
  eng=R(110, "hp", "im_c152", "Lycoming O-235-L2C, 110 BHP"),
  span=R(33.33, "ft", "im_c152", "wing span 33 ft 4 in"),
  mtow=R(1670, "lb", "im_c152", "maximum weight 1,670 lb"),
  ceil=P(14700, "ft", "im_c152", "service ceiling 14,700 ft"),
  roc=P(715, "fpm", "im_c152", "rate of climb at sea level 715 fpm"),
  vy=R(67, "kt", "im_c152", "best rate of climb speed 67 KIAS"),
  tas=P(107, "kt", "im_c152", "cruise, 75% power at 8,000 ft: 107 kt"), cruise={"power": "75%", "alt_ft": 8000},
  rng=P(320, "nm", "im_c152", "range 320 NM (24.5 gal usable, 75% at 8,000 ft); 545 NM with 37.5 gal tanks"),
  to=R(1340, "ft", "im_c152", "total distance over 50-ft obstacle 1,340 ft (ground roll 725 ft)"),
  ldg=R(1200, "ft", "im_c152", "total distance over 50-ft obstacle 1,200 ft (ground roll 475 ft)"),
  vso=R(43, "kt", "im_c152", "stall speed flaps down, power off 43 KCAS"),
  vat=R(54, "kt", "im_c152", "short-field landing approach speed 54 KIAS"))

T("C172", name="Cessna 172 Skyhawk", variant="172S Skyhawk SP (1998–), Lycoming IO-360-L2A 180 hp", kind="piston", n=1, fuel="avgas",
  eng=P(180, "hp", "tx_skyhawk", "Lycoming IO-360-L2A, 180 hp"),
  span=P(36.08, "ft", "tx_skyhawk", "wingspan 36 ft 1 in (11.00 m)"),
  mtow=P(2550, "lb", "tx_skyhawk", "maximum takeoff weight 2,550 lb (1,157 kg)"),
  ceil=P(14000, "ft", "tx_skyhawk", "service ceiling 14,000 ft"),
  roc=P(730, "fpm", "tx_skyhawk", "maximum climb rate 730 fpm"),
  vy=P(74, "kt", "poh_c172s", "Vy 74 KIAS at sea level (POH p. 4-5)"),
  tas=P(124, "kt", ["poh_c172s", "tx_skyhawk"], "75% power (2700 rpm) at 8,000 ft, ISA: 124 KTAS (POH p. 5-20); maximum cruise speed 124 ktas"), cruise={"power": "75%", "alt_ft": 8000},
  rng=P(638, "nm", "poh_c172s", "range 638 NM at 45% power, 10,000 ft, 53 gal usable, 45-min reserve (518 NM at 75%, 8,500 ft)"),
  to=P(1630, "ft", "tx_skyhawk", "takeoff distance 1,630 ft (ground roll 960 ft)"),
  ldg=P(1335, "ft", "tx_skyhawk", "landing distance 1,335 ft (ground roll 575 ft)"),
  vso=P(48, "kt", "tx_skyhawk", "stall speed 48 kcas"),
  v50=P(56, "kt", "poh_c172s", "short-field takeoff: lift-off 51 KIAS, speed at 50 ft 56 KIAS (p. 5-14)"),
  app=P(70, "kt", "poh_c172s", "normal approach, flaps up 65–75 KIAS (p. 4-5); midpoint"),
  vat=P(61, "kt", "poh_c172s", "short-field approach, flaps 30°: 61 KIAS (p. 4-5)"),
  ff=P(10.4, "gph", "poh_c172s", "75% power, 8,000 ft, ISA: 10.4 GPH at 124 KTAS (p. 5-20)"), ff_meta={"setting": "75% power, 2700 rpm, best-power/recommended lean", "alt_ft": 8000, "tas_kt": 124})

T("C177", name="Cessna 177 Cardinal", variant="177B (1975–78), Lycoming O-360-A1F6D 180 hp", kind="piston", n=1, fuel="avgas",
  eng=P(180, "hp", "cf_177b", "Lycoming O-360-A1F6D, 180 hp"),
  span=P(10.85, "m", "cf_177b", "wingspan about 35.6 ft / 10.85 m"),
  mtow=P(2500, "lb", "cf_177b", "gross weight 2,500 lb"),
  ceil=P(14600, "ft", "cf_177b", "service ceiling 14,600 ft"),
  roc=P(840, "fpm", "cf_177b", "max climb at sea level, gross weight 840 fpm"),
  tas=P(130, "kt", "cf_177b", "recommended cruise 130 kt (maximum cruise 139 kt); power and altitude not stated"), cruise={"power": "recommended cruise (not stated)", "alt_ft": None},
  rng=P(772, "nm", "cf_177b", "standard tanks, recommended cruise, no reserve: 772 NM (942 NM long-range tanks)"),
  to=P(1400, "ft", "cf_177b", "over 50-ft obstacle 1,400 ft (ground run 750 ft)"),
  ldg=P(1220, "ft", "cf_177b", "over 50-ft obstacle 1,220 ft (ground roll 600 ft)"),
  vso=P(46, "kt", "cf_177b", "stall speed 46 kt"))

T("C182", name="Cessna 182 Skylane", variant="182T Skylane (2001–), Lycoming IO-540-AB1A5 230 hp", kind="piston", n=1, fuel="avgas",
  eng=P(230, "hp", "tx_skylane", "Lycoming IO-540-AB1A5, 230 hp"),
  span=P(36.0, "ft", "tx_skylane", "wingspan 36 ft (10.97 m)"),
  mtow=P(3100, "lb", "tx_skylane", "maximum takeoff weight 3,100 lb (MLW 2,950 lb)"),
  ceil=P(18100, "ft", "tx_skylane", "service ceiling 18,100 ft"),
  roc=P(924, "fpm", "tx_skylane", "maximum climb rate 924 fpm"),
  tas=P(145, "kt", "tx_skylane", "maximum cruise speed 145 ktas (POH: 80% power at 6,000–7,000 ft)"), cruise={"power": "80% (maximum cruise)", "alt_ft": 7000},
  rng=P(915, "nm", "tx_skylane", "maximum range 915 nm (87 gal usable)"),
  to=P(1514, "ft", "tx_skylane", "takeoff distance 1,514 ft (ground roll 795 ft)"),
  ldg=P(1350, "ft", "tx_skylane", "landing distance 1,350 ft (ground roll 590 ft)"),
  vso=P(49, "kt", "tx_skylane", "stall speed 49 kcas"))

T("C206", name="Cessna 206 Stationair", variant="T206H Turbo Stationair HD (current), Lycoming TIO-540-AJ1A 310 hp", kind="piston", n=1, fuel="avgas", turbo=True,
  eng=P(310, "hp", "tx_t206hd", "Lycoming TIO-540-AJ1A, 310 hp"),
  span=P(36.0, "ft", "tx_t206hd", "wingspan 36 ft (10.97 m)"),
  mtow=P(3789, "lb", "tx_t206hd", "maximum takeoff weight 3,789 lb (HD; MLW 3,600 lb)"),
  ceil=P(26000, "ft", "tx_t206hd", "service ceiling 26,000 ft"),
  roc=P(960, "fpm", "tx_t206hd", "maximum climb rate 960 fpm"),
  tas=P(161, "kt", "tx_t206hd", "maximum cruise speed 161 ktas (T206H POH supplement: 75% power at 20,000 ft)"), cruise={"power": "75%", "alt_ft": 20000},
  rng=P(703, "nm", "tx_t206hd", "maximum range 703 nm"),
  to=P(1970, "ft", "tx_t206hd", "takeoff distance 1,970 ft (ground roll 1,060 ft)"),
  ldg=P(1395, "ft", "tx_t206hd", "landing distance 1,395 ft (ground roll 735 ft)"),
  vso=P(57, "kt", "tx_t206hd", "stall speed 57 kcas"),
  notes=["ICAO C206 covers the normally aspirated 206 and the turbocharged T206; the current production T206H HD is used (turbo)."])

T("C207", name="Cessna 207 Skywagon / Stationair 8", variant="207/207A (normally aspirated), Continental IO-520-F 300 hp", kind="piston", n=1, fuel="avgas",
  eng=R(300, "hp", "pp_c207", "Continental IO-520-F, 300 hp"),
  span=R(35.83, "ft", "pp_c207", "wing span 35 ft 10 in"),
  mtow=P(3800, "lb", "pp_c207", "gross weight 3,800 lb"),
  ceil=P(13300, "ft", "pp_c207", "ceiling 13,300 ft"),
  roc=P(810, "fpm", "pp_c207", "initial climb rate 810 fpm"),
  tas=P(143, "kt", "pp_c207", "cruise 165 mph (143 kt); power/altitude not stated"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to=P(1970, "ft", "pp_c207", "takeoff distance (50 ft) 1,970 ft"),
  vso_est=(55, "est: Vso of the similar-size Cessna 206 (54–57 kt) — no published figure found"),
  notes=["No published landing distance or range found; both estimated."],
  ldg_est=(1500, "est: about 0.75 × takeoff distance, as for the C206/C182 (T206H 0.71, C182T 0.89) — no published figure found"))

T("C210", name="Cessna 210 Centurion", variant="T210N Turbo Centurion II (1979–86), Continental TSIO-520-R 310 hp", kind="piston", n=1, fuel="avgas", turbo=True,
  eng=R(310, "hp", "pp_t210n", "Continental TSIO-520-R, 310 hp"),
  span=R(36.75, "ft", "pp_t210n", "wing span 36 ft 9 in"),
  mtow=P(4000, "lb", "pp_t210n", "gross weight 4,000 lb (max ramp 4,016 lb)"),
  ceil=P(27000, "ft", "pp_t210n", "service ceiling 27,000 ft"),
  roc=P(1035, "fpm", "pp_t210n", "best rate of climb (SL) 1,035 fpm"),
  tas=P(174, "kt", "pp_t210n", "cruise at 10,000 ft, 75% power: 174 kt (65%: 164 kt)"), cruise={"power": "75%", "alt_ft": 10000},
  to=P(2160, "ft", "pp_t210n", "takeoff over 50-ft obstacle 2,160 ft (ground roll 1,300 ft)"),
  vso_est=(60, "est: typical for the type class (T206H 57 kt, 4,000 lb retractable) — no published figure found"),
  ldg_est=(1650, "est: about 0.75 × takeoff distance (see C207) — no published figure found"),
  notes=["ICAO C210 covers 210 and T210; the T210N (turbocharged) is used because its data was found."])

T("PA18", name="Piper PA-18 Super Cub", variant="PA-18-150 Super Cub, Lycoming O-320 150 hp", kind="piston", n=1, fuel="avgas",
  eng=R(150, "hp", "pp_pa18", "Lycoming O-320, 150 hp"),
  span=R(35.33, "ft", "pp_pa18", "wing span 35 ft 4 in"),
  mtow=P(1750, "lb", "pp_pa18", "gross weight 1,750 lb"),
  ceil=P(19000, "ft", "pp_pa18", "ceiling 19,000 ft"),
  roc=P(960, "fpm", "pp_pa18", "initial climb rate 960 fpm"),
  tas=P(100, "kt", "pp_pa18", "cruise 115 mph (100 kt)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to=P(500, "ft", "pp_pa18", "takeoff distance (50 ft) 500 ft"),
  ldg=P(725, "ft", "pp_pa18", "landing distance (50 ft) 725 ft"),
  vso=P(37, "kt", "pp_pa18", "stall 43 mph (37 kt)"))

T("PA38", name="Piper PA-38 Tomahawk", variant="PA-38-112 Tomahawk, Lycoming O-235-L2C 112 hp", kind="piston", n=1, fuel="avgas",
  eng=R(112, "hp", "pp_pa38", "Lycoming O-235-L2C, 112 hp"),
  span=R(34.0, "ft", "pp_pa38", "wing span 34 ft"),
  mtow=P(1670, "lb", "pp_pa38", "gross weight 1,670 lb"),
  ceil=P(13000, "ft", G, "service ceiling 13,000 ft (Plane & Pilot gives 12,000 ft; Aeropedia 12,850 ft)"),
  roc=P(718, "fpm", G, "rate of climb 718 fpm"),
  tas=P(109, "kt", "aero_pa38", "75% power at 8,800 ft: 202 km/h (109 kt)"), cruise={"power": "75%", "alt_ft": 8800},
  to=P(1460, "ft", "pp_pa38", "takeoff over 50 ft 1,460 ft"),
  ldg=P(1544, "ft", "aggr_misc", "landing over 50 ft 1,544 ft (aviatorinsider; Plane & Pilot gives 1,374 ft)"),
  vso=P(49, "kt", G, "stall speed 49 kt"))

T("P28A", name="Piper PA-28 Cherokee / Warrior / Archer", variant="PA-28-181 Archer III / LX, Lycoming O-360 180 hp", kind="piston", n=1, fuel="avgas",
  eng=P(180, "hp", "piper_archer_lx", "180-horsepower Lycoming engine"),
  span=R(35.5, "ft", "pp_archer3", "wing span 35 ft 6 in"),
  mtow=P(2550, "lb", "pp_archer3", "gross weight 2,550 lb"),
  ceil=P(14100, "ft", "piper_archer_lx", "max approved altitude 14,100 ft"),
  roc=P(667, "fpm", "pp_archer3", "best rate of climb 667 fpm"),
  tas=P(128, "kt", "piper_archer_lx", "max cruise speed 128 ktas"), cruise={"power": "maximum cruise (75%)", "alt_ft": None},
  rng=P(522, "nm", "piper_archer_lx", "max range 522 nm"),
  to=R(1608, "ft", "pp_archer3", "takeoff over 50-ft obstacle 1,608 ft (Archer III POH figure)"),
  ldg=R(1390, "ft", "pp_archer3", "landing over 50-ft obstacle 1,390 ft (Archer III POH figure)"),
  vso=R(45, "kt", "pp_archer3", "stall speed, landing configuration 45 KIAS"),
  ff=P(10.0, "gph", "pp_archer3", "75% power: 10.0 gph at 120 kt; 65%: 8.6 gph (1999 Archer III)"), ff_meta={"setting": "75% power", "alt_ft": None, "tas_kt": 120})

T("P28R", name="Piper PA-28R Arrow", variant="PA-28R-201 Arrow III, Lycoming IO-360-C1C6 200 hp", kind="piston", n=1, fuel="avgas",
  eng=R(200, "hp", "wiki_types", "Lycoming IO-360-C1C6, 200 hp"),
  span=R(35.42, "ft", "wiki_types", "wing span 35 ft 5 in"),
  mtow=P(2750, "lb", "wiki_types", "gross weight 2,750 lb (1,247 kg)"),
  ceil=P(16200, "ft", "wiki_types", "service ceiling 16,200 ft"),
  roc=P(831, "fpm", "wiki_types", "initial rate of climb 831 fpm"),
  tas=P(138, "kt", G, "normal cruise 138 kt (power not stated)"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  to=P(1600, "ft", G, "takeoff distance 1,600 ft (basis not stated; treated as over 50 ft)"),
  ldg=P(1525, "ft", G, "landing distance 1,525 ft (basis not stated; treated as over 50 ft)"),
  vso_est=(55, "est: Arrow-class retractable (C177RG 50 kt, PA-28-181 45 kt with lighter wing loading) — no published figure found"))

T("P28T", name="Piper PA-28RT Turbo Arrow", variant="PA-28R(T)-201T Turbo Arrow III/IV, Continental TSIO-360-F 200 hp", kind="piston", n=1, fuel="avgas", turbo=True,
  eng=R(200, "hp", "pp_turbo_arrow", "Continental TSIO-360-F/FB, 200 hp"),
  span=R(35.42, "ft", "pp_turbo_arrow", "wing span 35 ft 5 in"),
  mtow=P(2900, "lb", "pp_turbo_arrow", "gross weight 2,900 lb"),
  ceil=R(20000, "ft", "pp_turbo_arrow", "service ceiling 20,000 ft"),
  roc=R(940, "fpm", "pp_turbo_arrow", "best rate of climb 940 fpm"),
  tas=P(172, "kt", "pp_turbo_arrow", "cruise, 75% power: 172 kt"), cruise={"power": "75%", "alt_ft": None},
  to_gr=P(1110, "ft", "pp_turbo_arrow", "takeoff ground roll 1,110 ft"),
  ldg_gr=P(645, "ft", "pp_turbo_arrow", "landing ground roll 645 ft"),
  vso_est=(58, "est: as P28R plus heavier 2,900 lb gross — no published figure found"),
  ff=P(12, "gph", "pp_turbo_arrow", "fuel consumption at 75% power 12 gph"), ff_meta={"setting": "75% power", "alt_ft": None, "tas_kt": 172},
  notes=["The 1978 Turbo Arrow III (PA-28R-201T) data is used; the T-tail Arrow IV (PA-28RT-201T) shares the engine and weights."])

T("PA32", name="Piper PA-32 Cherokee Six", variant="PA-32-300 Cherokee Six (1972), Lycoming IO-540-K 300 hp", kind="piston", n=1, fuel="avgas",
  eng=R(300, "hp", "pp_pa32", "Lycoming IO-540-K, 300 hp"),
  span=R(32.75, "ft", "pp_pa32", "wing span 32 ft 9 in"),
  mtow=P(3400, "lb", "pp_pa32", "gross weight 3,400 lb"),
  ceil=P(16250, "ft", "pp_pa32", "service ceiling 16,250 ft"),
  roc=P(1050, "fpm", "pp_pa32", "best rate of climb 1,050 fpm"),
  tas=P(140, "kt", "pp_pa32", "cruise 65% power: 140 kt (75%: 146 kt)"), cruise={"power": "65%", "alt_ft": None},
  to_gr=P(700, "ft", "pp_pa32", "short takeoff ground roll 700 ft"),
  ldg_gr=P(630, "ft", "pp_pa32", "short landing ground roll 630 ft"),
  vso=P(55, "kt", G, "stall speed 55 kt (configuration not stated)"))

T("P32R", name="Piper PA-32R Lance / Saratoga", variant="PA-32R-301 Saratoga II HP, Lycoming IO-540-K1G5 300 hp", kind="piston", n=1, fuel="avgas",
  eng=R(300, "hp", G, "Lycoming IO-540-K1G5, 300 hp"),
  span=R(36.17, "ft", G, "wing span 36 ft 2 in"),
  mtow=P(3600, "lb", G, "max takeoff weight 3,600 lb"),
  ceil=P(15588, "ft", G, "service ceiling 15,588 ft (Saratoga II HP page)"),
  roc=P(957, "fpm", G, "rate of climb 957 fpm"),
  tas=P(163, "kt", G, "normal cruise 163 kt (power not stated)"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  to_gr=P(1200, "ft", G, "takeoff distance 1,200 ft (treated as ground roll; basis not stated)"),
  ldg_gr=P(640, "ft", G, "landing distance 640 ft (treated as ground roll; basis not stated)"),
  vso_est=(60, "est: PA-32 class (Cherokee Six 55 kt at 3,400 lb, scaled to 3,600 lb and retractable) — no published figure found"))

T("PA46", name="Piper PA-46 Malibu / Mirage", variant="PA-46-350P M350 (Mirage), Lycoming TIO-540-AE2A 350 hp", kind="piston", n=1, fuel="avgas", turbo=True, press=True,
  eng=R(350, "hp", "piper_m350", "Lycoming TIO-540-AE2A, 350 hp"),
  span=P(43.0, "ft", "piper_m350", "wingspan 43 ft (13.1 m)"),
  mtow=P(4340, "lb", "piper_m350", "maximum takeoff weight 4,340 lb"),
  ceil=P(25000, "ft", "piper_m350", "max approved altitude 25,000 ft"),
  roc=P(1275, "fpm", "aopa_m350", "rate of climb, sea level 1,275 fpm"),
  tas=P(213, "kt", "piper_m350", "max cruise speed 213 ktas"), cruise={"power": "maximum cruise", "alt_ft": 25000},
  rng=P(1343, "nm", "piper_m350", "max range 1,343 nm"),
  to=P(2090, "ft", "piper_m350", "takeoff distance over 50-ft obstacle 2,090 ft (ground roll 1,087 ft)"),
  ldg=P(1968, "ft", "piper_m350", "landing distance over 50-ft obstacle 1,968 ft (ground roll 1,020 ft)"),
  vso=P(58, "kt", "aopa_m350", "VSO 58 kt (VS1 69 kt)"),
  ff=P(20, "gph", "aopa_m350", "about 20 gph at 75% power, best economy"), ff_meta={"setting": "75% power, best economy", "alt_ft": None, "tas_kt": None})

T("SR20", name="Cirrus SR20", variant="SR20 G6 (2016–), Lycoming IO-390-C3B6 215 hp", kind="piston", n=1, fuel="avgas",
  eng=P(215, "hp", G, "Lycoming IO-390-C3B6, 215 hp (several G6 listings)"),
  span=R(38.33, "ft", G, "wing span 38 ft 4 in"),
  mtow=P(3150, "lb", G, "max takeoff weight 3,150 lb (several G6 listings)"),
  ceil=P(17500, "ft", G, "service ceiling 17,500 ft"),
  roc_est=(900, "est: SR20 G3 published 920 fpm (GlobalAir) less ~2% for the heavier G6; no G6 figure found"),
  tas=P(155, "kt", "aggr_misc", "cruise about 155 KTAS at about 13 gph (G6 listings)"), cruise={"power": "normal cruise (~75%)", "alt_ft": None},
  vso_est=(56, "est: SR20 class (no G6 POH figure found)"),
  notes=["Takeoff/landing distances: only balanced-field/landing figures with unknown basis were found (1,909 / 2,674 ft); estimated instead."],
  to_est=(1700, "est: SR20 G6 listing gives 1,909 ft 'balanced field' (basis unknown); rounded down to a typical POH 50-ft figure for 215 hp at 3,150 lb (between C172S 1,630 and C182T 1,514 corrected for power loading)"),
  ldg_est=(1700, "est: similar wing loading to SR22; no published 50-ft landing figure found"))

T("SR22", name="Cirrus SR22", variant="SR22 G6 (normally aspirated), Continental IO-550-N 310 hp", kind="piston", n=1, fuel="avgas",
  eng=P(310, "hp", "pilot_sr22", "Continental IO-550-N, 310 hp"),
  span=R(38.33, "ft", "pilot_sr22", "wing span 38 ft 4 in"),
  mtow=R(3600, "lb", "pilot_sr22", "maximum takeoff weight 3,600 lb for G6 (the guide lists 3,400 lb, the earlier G2/G3 value)"),
  ceil=P(17500, "ft", "pilot_sr22", "service ceiling 17,500 ft"),
  roc=P(1270, "fpm", "pilot_sr22", "rate of climb 1,270 fpm"),
  tas=P(183, "kt", "pilot_sr22", "max cruise speed (75%) 183 KTAS"), cruise={"power": "75%", "alt_ft": None},
  vso_est=(60, "est: SR22 G6 POH stall figure not found; ~60 KCAS is typical for 3,600 lb on this wing"),
  to_est=(1600, "est: no published 50-ft takeoff found (only a 2,015 ft 'balanced field' of unknown basis)"),
  ldg_est=(2300, "est: no published 50-ft landing found (only a 3,341 ft figure of unknown basis); SR22 is known for long landing distances"),
  notes=["ICAO SR22 covers the SR22 and turbocharged SR22T (MSFS 2024 default). The normally aspirated SR22 is used to match XPerf's current non-turbo treatment; SR22T: 315 hp, 213 ktas, FL250, 1,021 nm (cirrusaircraft.com)."])

T("DA40", name="Diamond DA40", variant="DA40 NG, Austro Engine AE 300 turbo-diesel 168 hp (Jet A)", kind="piston", n=1, fuel="jet-a", diesel=True, turbo=True,
  eng=P(168, "hp", "diamond_da40", "Austro Engine AE 300 turbocharged common-rail diesel, 168 hp"),
  span=P(11.63, "m", "diamond_da40", "wingspan 11.63 m / 38 ft 3 in"),
  mtow=P(1310, "kg", "diamond_da40", "MTOM 1,310 kg / 2,888 lb"),
  ceil=P(16400, "ft", "diamond_da40", "max. operating altitude 16,400 ft"),
  roc=P(651, "fpm", "diamond_da40", "rate of climb (MSL) 651 ft/min"),
  tas=P(124, "kt", "diamond_da40", "cruise at 60% (14,000 ft) 124 KTAS; max cruise 154 KTAS at 16,000 ft MCP"), cruise={"power": "60%", "alt_ft": 14000},
  rng=P(934, "nm", "diamond_da40", "max. range 934 nm (FL160, 50% power, incl. climb, no reserves)"),
  to=P(590, "m", "diamond_da40", "take-off ground roll / obstacle distance 397 m / 590 m"),
  ldg=P(650, "m", "diamond_da40", "landing ground roll / landing distance 318 m / 650 m"),
  vso=P(58, "kt", "diamond_da40", "stall speed, landing configuration 58 KCAS"),
  ff=P(19.3, "lph", "diamond_da40", "fuel consumption 19.3 l/h (5.1 US gal/h) at 60%"), ff_meta={"setting": "60% power", "alt_ft": 14000, "tas_kt": 124},
  notes=["ICAO DA40 also covers the avgas DA40 (Lycoming IO-360, 180 hp: 142 KTAS MCP at MSL, 8.2 gal/h at 65%) — same Diamond page."])

T("DA50", name="Diamond DA50", variant="DA50 RG, Continental CD-300 turbo-diesel 300 hp (Jet A) — single engine", kind="piston", n=1, fuel="jet-a", diesel=True, turbo=True,
  eng=P(300, "hp", "diamond_da50", "Continental CD-300 V6 diesel, 300 hp take-off (270 hp max continuous)"),
  span=R(44.0, "ft", "diamond_da50", "wing span about 44 ft"),
  mtow=P(1999, "kg", "diamond_da50", "MTOW 1,999 kg / 4,407 lb"),
  ceil=P(20000, "ft", "diamond_da50", "service ceiling 20,000 ft"),
  roc=P(1050, "fpm", "diamond_da50", "best rate of climb about 1,050 fpm"),
  tas=P(172, "kt", "diamond_da50", "cruise at 82% power, 14,000 ft: about 172 KTAS (max 181 KTAS)"), cruise={"power": "82%", "alt_ft": 14000},
  rng=P(750, "nm", "diamond_da50", "range about 750 nm with 30-min reserve (820 nm without)"),
  to=P(1444, "ft", G, "takeoff distance 1,444 ft (basis not stated; treated as over 50 ft)"),
  ldg=P(1115, "ft", G, "landing distance 1,115 ft (basis not stated; treated as over 50 ft)"),
  vso=P(57, "kt", "diamond_da50", "stall speed about 57 KCAS, landing configuration"),
  ff=P(8.0, "gph", "diamond_da50", "about 8 US gal/h (30.2 l/h) at max-range power"), ff_meta={"setting": "max-range power", "alt_ft": None, "tas_kt": None},
  notes=["The DA50 RG is a single-engine aircraft (L1P). XPerf's current upstream data types it L2P and mixes in the unrelated DA50 Superstar/Magnum prototypes."])

T("DR40", name="Robin DR400", variant="DR400/180 Régent, Lycoming O-360-A 180 hp", kind="piston", n=1, fuel="avgas",
  eng=P(180, "hp", "fi_dr400", "Lycoming O-360-A3A, 180 hp"),
  span=R(8.72, "m", "aero_dr400", "wing span 8.72 m"),
  mtow=P(1100, "kg", "aero_dr400", "maximum take-off weight 1,100 kg"),
  ceil=P(15500, "ft", "aero_dr400", "service ceiling about 4,724 m (15,500 ft)"),
  roc=P(826, "fpm", "aero_dr400", "rate of climb at sea level 826 ft/min"),
  tas=P(130, "kt", "aero_dr400", "cruise 65% power at 8,500 ft: 241 km/h (130 kt); 75%: 254 km/h (137 kt)"), cruise={"power": "65%", "alt_ft": 8500},
  rng=P(783, "nm", "fi_dr400", "range 1,450 km (783 NM)"),
  to=P(610, "m", "aero_dr400", "take-off over 15 m (50 ft) obstacle about 610 m (ground roll 315 m)"),
  ldg=P(530, "m", "aero_dr400", "landing over 15 m (50 ft) obstacle about 530 m"),
  vso_est=(52, "est: DR400 class (no published landing-configuration stall speed found)"),
  notes=["Aeropedia's DR400/180 entry names a 200 hp engine in its text while the data match the 180 hp Régent; engine taken from flugzeuginfo."])

T("BE23", name="Beechcraft Musketeer / Sundowner", variant="C23 Sundowner 180, Lycoming O-360-A4K 180 hp", kind="piston", n=1, fuel="avgas",
  eng=R(180, "hp", "aopa_c23", "Lycoming O-360-A4K/A4G, 180 hp"),
  span=R(32.75, "ft", "aopa_c23", "wing span 32 ft 9 in"),
  mtow=P(2450, "lb", "aopa_c23", "takeoff/landing weight, normal category 2,450 lb"),
  ceil=P(12600, "ft", "pp_c23", "service ceiling 12,600 ft"),
  roc=P(792, "fpm", "pp_c23", "best rate of climb 792 fpm"),
  tas=P(118, "kt", "pp_c23", "cruise 75% power 118 kt"), cruise={"power": "75%", "alt_ft": None},
  to=P(1955, "ft", "pp_c23", "takeoff distance to clear 50 ft 1,955 ft (ground roll 1,130 ft)"),
  ldg=P(1484, "ft", "pp_c23", "landing distance over 50 ft 1,484 ft (ground roll 703 ft)"),
  vso=P(52, "kt", "aopa_c23", "stall, landing configuration 52 kt (Plane & Pilot 51 kt)"))

T("BE33", name="Beechcraft Debonair / Bonanza 33", variant="F33A Bonanza (1970–94), Continental IO-520-BB 285 hp", kind="piston", n=1, fuel="avgas",
  eng=P(285, "hp", "aggr_misc", "Continental IO-520-BB, 285 hp at 2,700 rpm (airpowerinc.com engine page)"),
  span=R(33.5, "ft", G, "wing span 33 ft 6 in"),
  mtow=P(3400, "lb", G, "max takeoff weight 3,400 lb"),
  ceil=P(18000, "ft", G, "service ceiling 18,000 ft"),
  roc=P(1167, "fpm", G, "rate of climb 1,167 fpm"),
  tas=P(172, "kt", G, "normal cruise 172 kt (max 182 kt)"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  vso_est=(55, "est: Bonanza class (G36 Vso ≈ 59 kt at 3,650 lb, scaled to 3,400 lb)"),
  to_est=(1750, "est: F33A at 3,400 lb is lighter than the G36 (1,913 ft at 3,650 lb, 300 hp); scaled by weight² / power"),
  ldg_est=(1400, "est: G36 class landing distance; no published F33A 50-ft figure found"),
  notes=["Only aggregator (GlobalAir) data found for the F33A — verify against the POH before release."])

T("BE36", name="Beechcraft Bonanza A36", variant="G36 Bonanza (2006–), Continental IO-550-B 300 hp", kind="piston", n=1, fuel="avgas",
  eng=R(300, "hp", "pp_g36", "Continental IO-550-B, 300 hp"),
  span=R(33.5, "ft", "pp_g36", "wing span 33 ft 6 in"),
  mtow=R(3650, "lb", "pp_g36", "max takeoff weight 3,650 lb"),
  ceil=P(18500, "ft", "pp_g36", "service ceiling 18,500 ft"),
  roc=R(1030, "fpm", "pp_g36", "rate of climb 1,030 fpm"),
  tas=P(176, "kt", "pp_g36", "max cruise speed (75%) 176 KTAS"), cruise={"power": "75%", "alt_ft": None},
  rng=P(929, "nm", "pp_g36", "maximum range 929 nm"),
  to=P(1913, "ft", "pp_g36", "takeoff over 50 ft 1,913 ft (Beechcraft data)"),
  ldg=P(1450, "ft", "aggr_misc", "landing distance 1,450 ft (one listing; another gives 2,417 ft)"),
  vso=R(59, "kt", "pp_g36", "stall, landing configuration 59 KIAS"))

T("M20P", name="Mooney M20 (normally aspirated)", variant="M20J 201, Lycoming IO-360-A3B6D 200 hp", kind="piston", n=1, fuel="avgas",
  eng=R(200, "hp", G, "Lycoming IO-360-A3B6D, 200 hp"),
  span=R(36.08, "ft", G, "wing span 36 ft 1 in"),
  mtow=P(2740, "lb", G, "max takeoff weight 2,740 lb"),
  ceil=P(18800, "ft", G, "service ceiling 18,800 ft"),
  roc=P(1030, "fpm", G, "rate of climb 1,030 fpm"),
  tas=P(169, "kt", G, "normal cruise 169 kt (power not stated)"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  vso_est=(55, "est: M20J class; no published figure found"),
  to_est=(1550, "est: no published 50-ft takeoff found (GlobalAir's 970 ft is likely a ground roll: 970 × 1.6)"),
  ldg_est=(1550, "est: no published 50-ft landing found (GlobalAir's 800 ft is likely a ground roll: 800 × 1.9)"),
  notes=["Only aggregator data found for the M20J — verify against the POH before release."])

T("M20T", name="Mooney M20 Turbo", variant="M20TN Acclaim Type S, Continental TSIO-550-G 280 hp", kind="piston", n=1, fuel="avgas", turbo=True,
  eng=P(280, "hp", "pp_acclaim", "Continental TSIO-550-G, 280 hp take-off"),
  span=R(36.08, "ft", "pp_acclaim", "wing span 36 ft 1 in"),
  mtow=P(3368, "lb", "fr_acclaim", "max takeoff weight about 3,368 lb (ramp 3,374 lb)"),
  ceil=P(25000, "ft", "pp_acclaim", "max operating altitude FL250"),
  roc=P(1240, "fpm", "pp_acclaim", "rate of climb at sea level 1,240 fpm"),
  tas=P(237, "kt", "pp_acclaim", "75% power at FL250: 237 kt"), cruise={"power": "75%", "alt_ft": 25000},
  to=P(1620, "ft", "fr_acclaim", "takeoff over 50-ft obstacle 1,620 ft (ground roll 1,380 ft)"),
  vso_est=(59, "est: Acclaim class; no published figure found"),
  ldg_est=(1800, "est: no published 50-ft landing figure found"))

T("TAMP", name="Socata TB-9 Tampico", variant="TB-9 Tampico, Lycoming O-320-D2A 160 hp", kind="piston", n=1, fuel="avgas",
  eng=R(160, "hp", "aero_tb9", "Lycoming O-320-D2A, 160 hp"),
  span=R(9.76, "m", "aero_tb9", "wing span 9.76 m"),
  mtow=P(1060, "kg", "aero_tb9", "loaded weight 1,060 kg (2,337 lb)"),
  ceil=P(14100, "ft", "aero_tb9", "service ceiling 4,300 m (about 14,100 ft)"),
  roc=P(700, "fpm", "aero_tb9", "initial climb 700 ft/min"),
  tas=P(121, "kt", "aero_tb9", "75% power cruise 225 km/h (121 kt)"), cruise={"power": "75%", "alt_ft": None},
  to=P(570, "m", "aero_tb9", "take-off distance to 15 m (50 ft) 570 m"),
  ldg=P(380, "m", "aero_tb9", "landing distance from 15 m (50 ft) 380 m"),
  vso_est=(50, "est: TB-series class; no published figure found"))

T("TOBA", name="Socata TB-10 Tobago", variant="TB-10 Tobago, Lycoming O-360-A1AD 180 hp", kind="piston", n=1, fuel="avgas",
  eng=R(180, "hp", "aero_tb9", "Lycoming O-360-A1AD, 180 hp"),
  span=R(9.76, "m", "aero_tb9", "wing span 9.76 m"),
  mtow=P(1150, "kg", "aero_tb9", "loaded weight 1,150 kg (2,530 lb)"),
  ceil=P(13000, "ft", "aero_tb9", "service ceiling 13,000 ft"),
  roc=P(790, "fpm", "aero_tb9", "climb rate 790 ft/min at sea level"),
  tas=P(127, "kt", "aero_tb9", "75% power cruise 235 km/h (127 kt)"), cruise={"power": "75%", "alt_ft": None},
  to=P(1657, "ft", G, "takeoff distance 1,657 ft (basis not stated; treated as over 50 ft)"),
  ldg=P(1509, "ft", G, "landing distance 1,509 ft (basis not stated; treated as over 50 ft)"),
  vso_est=(53, "est: TB-series class; no published figure found"))

T("TRIN", name="Socata TB-20 Trinidad", variant="TB-20 Trinidad (1984+ 1,400 kg), Lycoming IO-540-C4D5D 250 hp", kind="piston", n=1, fuel="avgas",
  eng=P(250, "hp", "aero_tb20", "Avco Lycoming IO-540-C4D5D, 187 kW (250 hp)"),
  span=R(9.76, "m", "aero_tb20", "wing span 9.76 m"),
  mtow=P(1400, "kg", "aero_tb20", "1984 update: maximum take-off weight 1,400 kg (3,086 lb)"),
  ceil=P(20000, "ft", "pp_tb20", "service ceiling 20,000 ft"),
  roc=P(1200, "fpm", "pp_tb20", "best rate of climb 1,200 fpm"),
  tas=P(157, "kt", "pp_tb20", "cruise 75% power 157 kt (65%: 153 kt)"), cruise={"power": "75%", "alt_ft": None},
  to_gr=P(1193, "ft", "pp_tb20", "takeoff ground roll 1,193 ft"),
  ldg_gr=P(755, "ft", "pp_tb20", "landing ground roll 755 ft"),
  vso_est=(59, "est: TB-20 class; no published figure found"))

T("RALL", name="Socata Rallye", variant="MS 893 Rallye 180 (Commodore / 180 GT), Lycoming O-360 180 hp", kind="piston", n=1, fuel="avgas",
  eng=R(180, "hp", "pp_rallye", "180 hp Lycoming"),
  span=P(9.60, "m", "skybrary", "wingspan 9.60 m (Rallye family)"),
  mtow=P(2315, "lb", "pp_rallye", "gross weight 2,315 lb"),
  ceil=P(11800, "ft", "pp_rallye", "ceiling 11,800 ft"),
  roc=P(760, "fpm", "pp_rallye", "initial climb rate 760 fpm"),
  tas=P(122, "kt", "pp_rallye", "cruise 140 mph (122 kt)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to_gr=P(445, "ft", "pp_rallye", "takeoff run 445 ft"),
  ldg_gr=P(425, "ft", "pp_rallye", "landing roll 425 ft"),
  vso=P(50, "kt", "pp_rallye", "stall 57 mph (50 kt)"),
  notes=["ICAO RALL covers 100–235 hp Rallyes; the 180 hp model is used."])

T("G115", name="Grob G115", variant="G 115E (Tutor), Lycoming AEIO-360-B1F 180 hp", kind="piston", n=1, fuel="avgas",
  eng=R(180, "hp", "wiki_types", "Lycoming AEIO-360-B1F, 180 hp"),
  span=R(10.0, "m", "wiki_types", "wing span 10.00 m"),
  mtow=P(990, "kg", "wiki_types", "max takeoff weight 990 kg"),
  ceil=P(16000, "ft", "aggr_misc", "ceiling 16,000 ft (sources range 10,000–20,000 ft)"),
  roc_est=(1000, "est: 180 hp at 990 kg (power loading similar to the DR400/180's 826 fpm, plus aerobatic-trainer prop); the single 1,500 fpm figure found is unconfirmed"),
  tas=P(124, "kt", "aggr_misc", "cruise about 124 kt (sprinkle/aerocorner)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to=P(460, "m", "aggr_misc", "take-off distance about 460 m (basis not stated; treated as over 15 m)"),
  ldg=P(380, "m", "aggr_misc", "landing distance about 380 m (basis not stated; treated as over 15 m)"),
  vso_est=(50, "est: light aerobatic trainer class; no published figure found"),
  notes=["Only aggregator data found — weak. ICAO G115 also covers 115/116 hp G 115A/B/C variants."])

# ======================= multi-engine piston ================================================
T("PA44", name="Piper PA-44 Seminole", variant="PA-44-180 Seminole (current), 2 × Lycoming IO-360 180 hp", kind="piston", n=2, fuel="avgas",
  eng=P(180, "hp", "piper_seminole", "(2) Lycoming IO-360-B1G6, flat-rated at 180 hp each"),
  span=P(38.5, "ft", "piper_seminole", "wingspan 38 ft 6 in (11.8 m)"),
  mtow=P(3800, "lb", "pp_pa44", "gross weight 3,800 lb"),
  ceil=P(17100, "ft", "pp_pa44", "service ceiling 17,100 ft (GlobalAir: 15,000 ft)"),
  roc=P(1340, "fpm", "pp_pa44", "best rate of climb 1,340 fpm"),
  tas=P(162, "kt", "piper_seminole", "max cruise speed 162 ktas (1979 data: 75% 166 kt, 65% 162 kt)"), cruise={"power": "maximum cruise", "alt_ft": None},
  rng=P(940, "nm", "piper_seminole", "max range 940 nm (108 US gal usable)"),
  to_gr=P(880, "ft", "pp_pa44", "takeoff ground roll 880 ft"),
  vso=P(59, "kt", "pp_pa44", "stall speed, gear and flaps down 59 kt"),
  ldg_est=(1500, "est: no published 50-ft landing found (the 383 ft 'ground roll' found is implausible); typical light-twin ratio to takeoff"))

T("PA34", name="Piper PA-34 Seneca", variant="PA-34-220T Seneca V, 2 × Continental TSIO-360-RB 220 hp", kind="piston", n=2, fuel="avgas", turbo=True,
  eng=R(220, "hp", "pp_seneca5", "Continental TSIO-360-RB, 220 hp each"),
  span=R(38.92, "ft", "pp_seneca5", "wing span 38 ft 11 in"),
  mtow=P(4750, "lb", "pp_seneca5", "max takeoff weight 4,750 lb (MLW 4,513 lb)"),
  ceil=P(25000, "ft", "pp_seneca5", "service ceiling 25,000 ft"),
  roc=P(1462, "fpm", "pp_seneca5", "rate of climb at sea level 1,462 fpm"),
  tas=P(197, "kt", "pp_seneca5", "cruise 75% power 197 kt"), cruise={"power": "75%", "alt_ft": None},
  rng=P(828, "nm", "pp_seneca5", "cruising range 828+ nm"),
  to=P(1707, "ft", "pp_seneca5", "takeoff over 50 ft obstacle 1,707 ft"),
  ldg=P(2180, "ft", "pp_seneca5", "landing over 50 ft obstacle 2,180 ft"),
  vso_est=(61, "est: Seneca V class; no published figure found"),
  notes=["ICAO PA34 covers the normally aspirated Seneca I and turbocharged II–V; the Seneca V (turbo) is used."])

T("PA23", name="Piper PA-23 Apache", variant="PA-23-160 Apache, 2 × Lycoming O-320 160 hp", kind="piston", n=2, fuel="avgas",
  eng=P(160, "hp", "pp_apache", "160 hp each"),
  span=R(37.0, "ft", "pp_apache", "wing span 37 ft"),
  mtow=P(3800, "lb", "pp_apache", "gross weight 3,800 lb"),
  ceil=P(17000, "ft", "pp_apache", "ceiling 17,000 ft"),
  roc=P(1260, "fpm", "pp_apache", "initial climb rate 1,260 fpm"),
  tas=P(150, "kt", "pp_apache", "cruise 173 mph (150 kt)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to_gr=P(1190, "ft", "pp_apache", "takeoff run 1,190 ft"),
  ldg_gr=P(750, "ft", "pp_apache", "landing roll 750 ft"),
  vso_est=(55, "est: Apache class; no published figure found"))

T("PA27", name="Piper PA-23 Aztec", variant="PA-23-250 Aztec (normally aspirated), 2 × Lycoming IO-540 250 hp", kind="piston", n=2, fuel="avgas",
  eng=R(250, "hp", "pp_aztec", "Lycoming IO-540-C4B5, 250 hp each"),
  span=R(37.17, "ft", "pp_aztec", "wing span 37 ft 2 in"),
  mtow=P(5200, "lb", "pp_aztec", "gross weight 5,200 lb"),
  ceil=P(17600, "ft", "pp_aztec", "ceiling 17,600 ft (normally aspirated)"),
  roc=P(1400, "fpm", "pp_aztec", "initial climb rate 1,400 fpm"),
  tas=P(179, "kt", "pp_aztec", "75% best-power cruise 206 mph (179 kt)"), cruise={"power": "75%", "alt_ft": 8000},
  rng=P(985, "nm", "pp_aztec", "range 1,134 statute miles (985 nm) with 45-min reserve at 75%"),
  to=P(1980, "ft", "pp_aztec", "takeoff distance (50 ft) 1,980 ft"),
  ldg=P(1585, "ft", "pp_aztec", "landing distance (50 ft) 1,585 ft"),
  vso_est=(61, "est: Aztec class; no published figure found"))

T("PA31", name="Piper PA-31 Navajo / Chieftain", variant="PA-31-350 Navajo Chieftain, 2 × Lycoming TIO-540-J2B 350 hp", kind="piston", n=2, fuel="avgas", turbo=True,
  eng=R(350, "hp", G, "Lycoming TIO-540/LTIO-540-J2BD, 350 hp each"),
  span=R(40.67, "ft", G, "wing span 40 ft 8 in"),
  mtow=P(7000, "lb", G, "max takeoff weight 7,000 lb"),
  ceil=P(24000, "ft", G, "service ceiling 24,000 ft (Aeropedia: 27,200 ft)"),
  roc=P(1270, "fpm", G, "rate of climb 1,270 fpm"),
  tas=P(175, "kt", G, "normal cruise 175 kt (max speed 225 kt)"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  to=P(2700, "ft", G, "balanced field length 2,700 ft (treated as takeoff distance)"),
  ldg=P(3000, "ft", G, "landing distance 3,000 ft (basis not stated)"),
  vso_est=(70, "est: Chieftain class; no published figure found"),
  notes=["Only aggregator data found — weak."])

T("BE76", name="Beechcraft Duchess", variant="76 Duchess, 2 × Lycoming O-360-A1G6D 180 hp", kind="piston", n=2, fuel="avgas",
  eng=R(180, "hp", "pp_be76", "Lycoming O-360-A1G6D, 180 hp each"),
  span=R(38.0, "ft", "pp_be76", "wing span 38 ft"),
  mtow=P(3900, "lb", "wiki_types", "maximum takeoff weight 3,900 lb"),
  ceil=P(19650, "ft", "wiki_types", "service ceiling 19,650 ft (one engine inoperative 6,170 ft)"),
  roc=P(1248, "fpm", "wiki_types", "rate of climb at sea level 1,248 fpm"),
  tas=P(158, "kt", "wiki_types", "cruise 158 kt at 10,000 ft"), cruise={"power": "cruise (not stated)", "alt_ft": 10000},
  to=P(2119, "ft", "pp_be76", "takeoff over 50 ft 2,119 ft"),
  ldg=P(1881, "ft", "pp_be76", "landing over 50 ft 1,881 ft"),
  vso_est=(60, "est: Duchess class; no published figure found"))

T("BE55", name="Beechcraft Baron 55", variant="B55 Baron (1980), 2 × Continental IO-470-L 260 hp", kind="piston", n=2, fuel="avgas",
  eng=R(260, "hp", "pp_b55", "Continental IO-470-L, 260 hp each"),
  span=R(37.83, "ft", "pp_b55", "wing span 37 ft 10 in"),
  mtow=P(5100, "lb", "pp_b55", "max takeoff and landing weight 5,100 lb"),
  ceil=P(19300, "ft", "pp_b55", "service ceiling 19,300 ft"),
  roc=P(1693, "fpm", "pp_b55", "best rate of climb 1,693 fpm"),
  tas=P(188, "kt", "pp_b55", "cruise 75% power at 8,000 ft: 188 kt"), cruise={"power": "75%", "alt_ft": 8000},
  rng=P(798, "nm", "pp_b55", "max range at 75% power 798 nm"),
  to=P(2154, "ft", "pp_b55", "takeoff distance (50 ft) 2,154 ft (older P&P standard data)"),
  ldg=P(2148, "ft", "pp_b55", "landing distance (50 ft) 2,148 ft (older P&P standard data)"),
  vso=P(73, "kt", "pp_b55", "stall speed, gear and flaps down 73 kt"))

T("BE58", name="Beechcraft Baron 58", variant="G58 Baron (2005–), 2 × Continental IO-550-C 300 hp", kind="piston", n=2, fuel="avgas",
  eng=R(300, "hp", "pp_g58", "Continental IO-550-C, 300 hp each"),
  span=R(37.83, "ft", "pp_g58", "wing span 37 ft 10 in"),
  mtow=R(5500, "lb", "pp_g58", "max takeoff weight 5,500 lb"),
  ceil=P(20688, "ft", "pp_g58", "service ceiling 20,688 ft"),
  roc=R(1700, "fpm", "pp_g58", "rate of climb 1,700 fpm"),
  tas=P(202, "kt", "pp_g58", "cruise 75% power 202 kt (55%: 177 kt)"), cruise={"power": "75%", "alt_ft": None},
  rng=P(1052, "nm", "pp_g58", "range 1,052 nm at 75% (1,388 nm at 55%)"),
  to=P(2345, "ft", "aopa_g58", "takeoff over 50-ft obstacle 2,345 ft (ground roll 1,373 ft)"),
  vso=R(75, "kt", "pp_g58", "stall, landing configuration 75 KIAS"),
  ldg_est=(2300, "est: B55 landing distance (2,148 ft at 5,100 lb) scaled by weight to 5,500 lb"),
  notes=["Plane & Pilot also gives an estimated fuel burn of 26–32 gph total (power not stated); not used as a cruise fuel flow."])

T("DA42", name="Diamond DA42 Twin Star", variant="DA42-VI, 2 × Austro Engine AE 300 turbo-diesel 168 hp (Jet A)", kind="piston", n=2, fuel="jet-a", diesel=True, turbo=True,
  eng=P(168, "hp", "diamond_da42", "2 × Austro Engine AE 300, 168 HP"),
  span_est=(13.55, "est: Diamond's drawing alt text says 14.55 m, which is the DA62 span; 13.55 m is the widely quoted DA42-VI span (not verified)"),
  mtow=P(1999, "kg", "diamond_da42", "MTOM 1,999 kg / 4,407 lbs"),
  ceil=P(18000, "ft", "diamond_da42", "max. operating altitude 18,000 ft"),
  roc=P(1400, "fpm", "pp_da42", "rate of climb at sea level 1,400 fpm (Diamond: 1,114 fpm at 1,760 kg TOW, ISA — not at MTOM)"),
  tas=P(175, "kt", "diamond_da42", "cruise speed at 75%, 16,000 ft: 175 KTAS (max 190 KTAS MCP)"), cruise={"power": "75%", "alt_ft": 16000},
  rng=P(1225, "nm", "diamond_da42", "max. range 1,225 nm (FL180, 50% power, incl. climb, no reserves)"),
  to=P(2129, "ft", "diamond_da42", "short-field take-off: ground roll / obstacle 375 m / 649 m (1,230 / 2,129 ft)"),
  ldg=P(2122, "ft", "diamond_da42", "landing: ground roll / landing distance 387 m / 647 m (1,269 / 2,122 ft)"),
  vso=P(62, "kt", "diamond_da42", "stall speed, landing configuration 62 KCAS"),
  ff=P(39.4, "lph", "diamond_da42", "consumption at 60% in total 39.4 l/h (10.4 US gal/h), both engines"), ff_meta={"setting": "60% power, both engines", "alt_ft": 12000, "tas_kt": None})

T("C310", name="Cessna 310", variant="310R (1975–81), 2 × Continental IO-520-M 285 hp", kind="piston", n=2, fuel="avgas",
  eng=R(285, "hp", "aopa_310r", "Continental IO-520-M, 285 hp each"),
  span=R(36.92, "ft", "aopa_310r", "wing span 36 ft 11 in"),
  mtow=P(5500, "lb", "aopa_310r", "maximum gross weight 5,500 lb"),
  ceil=P(19750, "ft", "aopa_310r", "service ceiling 19,750 ft"),
  roc=P(1662, "fpm", "aopa_310r", "sea-level rate of climb 1,662 fpm"),
  tas=P(190, "kt", "aopa_310r", "cruise speed just over 190 kt (power/altitude not stated)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  to=P(1770, "ft", "aopa_310r", "takeoff over 50-ft obstacle 1,770 ft (ground roll 1,335 ft)"),
  ldg=P(1790, "ft", "aopa_310r", "landing over 50-ft obstacle 1,790 ft (ground roll 640 ft)"),
  vso_est=(71, "est: 310R class (C340A 71 kt); no published figure found"))

T("C337", name="Cessna 337 Skymaster", variant="337G Super Skymaster (1973–80), 2 × Continental IO-360-GB 210 hp", kind="piston", n=2, fuel="avgas",
  eng=R(210, "hp", "pp_337", "Continental IO-360-G/GB, 210 hp each"),
  span=R(38.17, "ft", "pp_337", "wing span 38 ft 2 in"),
  mtow=P(4630, "lb", "pp_337", "gross weight 4,630 lb"),
  ceil=P(18000, "ft", "fo_337", "service ceiling (two engines) 18,000 ft"),
  roc=P(1100, "fpm", "fo_337", "rate of climb at sea level 1,100 fpm"),
  tas=P(169, "kt", "pp_337", "cruise 194 mph (169 kt)"), cruise={"power": "cruise (not stated)", "alt_ft": None},
  rng=P(545, "nm", "fo_337", "75% power at 5,500 ft: 545 nm / 3.3 h on 528 lb of fuel"),
  to=P(1675, "ft", "fo_337", "takeoff at full gross: ground 1,000 ft, over 50 ft 1,675 ft"),
  ldg=P(1650, "ft", "fo_337", "landing ground roll 700 ft, over 50 ft 1,650 ft"),
  vso=P(61, "kt", "fo_337", "flaps down, power off 61 KCAS"))

T("C340", name="Cessna 340", variant="340A (1976–84), 2 × Continental TSIO-520-NB 310 hp", kind="piston", n=2, fuel="avgas", turbo=True, press=True,
  eng=R(310, "hp", "pp_340", "Continental TSIO-520-NB, 310 hp each"),
  span=R(38.08, "ft", "pp_340", "wing span 38 ft 1 in"),
  mtow=P(5990, "lb", "aopa_340", "gross weight 5,990 lb (ramp 6,025 lb)"),
  ceil=P(29800, "ft", "aopa_340", "service ceiling 29,800 ft"),
  roc=P(1650, "fpm", "aopa_340", "best rate of climb 1,650 fpm"),
  tas=P(229, "kt", "pp_340", "75% power at 25,000 ft: 229 knots"), cruise={"power": "75%", "alt_ft": 25000},
  to=P(2175, "ft", "aopa_340", "takeoff over 50-ft obstacle 2,175 ft (ground roll 1,615 ft)"),
  ldg=P(1850, "ft", "aopa_340", "landing over 50-ft obstacle 1,850 ft (ground roll 770 ft)"),
  vso=P(71, "kt", "pp_340", "stall speed (flaps down) 71 kt (flaps up 79 kt)"))

T("C402", name="Cessna 401 / 402", variant="402C Businessliner (1979–85), 2 × Continental TSIO-520-VB 325 hp", kind="piston", n=2, fuel="avgas", turbo=True,
  eng=P(325, "hp", "wiki_types", "engines boosted to 325 hp each"),
  span=R(44.13, "ft", "wiki_types", "wing span 44 ft 1.5 in"),
  mtow=P(6850, "lb", "wiki_types", "max gross weight 6,850 lb"),
  ceil=P(26900, "ft", "pp_402", "ceiling 26,900 ft"),
  roc=P(1450, "fpm", "wiki_types", "climb 1,450 ft/min"),
  tas=P(195, "kt", "pp_402", "cruise 224 mph (195 kt); GlobalAir normal cruise 196 kt"), cruise={"power": "normal cruise (not stated)", "alt_ft": None},
  rng=P(1273, "nm", "wiki_types", "range 1,273 nm"),
  to=P(2195, "ft", "pp_402", "takeoff distance (50 ft) 2,195 ft"),
  ldg=P(2485, "ft", "pp_402", "landing distance (50 ft) 2,485 ft"),
  vso=P(68, "kt", "pp_402", "stall 78 mph (68 kt)"))

T("C414", name="Cessna 414 Chancellor", variant="414A Chancellor (1978–85), 2 × Continental TSIO-520-NB 310 hp", kind="piston", n=2, fuel="avgas", turbo=True, press=True,
  eng=R(310, "hp", "pp_414", "Continental TSIO-520-NB, 310 hp each"),
  span=R(44.13, "ft", "aero_c414", "wing span 44 ft 1.5 in"),
  mtow=P(6750, "lb", "aero_c414", "maximum takeoff and landing weight 6,750 lb (3,061 kg)"),
  ceil=P(30800, "ft", "aero_c414", "service ceiling 30,800 ft"),
  roc=P(1520, "fpm", "aero_c414", "twin-engine climb at MTOW, ISA about 1,520 fpm"),
  tas=P(214, "kt", "aero_c414", "75% power, FL250: 214 KTAS (65%: 202 KTAS)"), cruise={"power": "75%", "alt_ft": 25000},
  to=P(2595, "ft", "pp_414", "takeoff distance (50 ft) 2,595 ft"),
  ldg=P(2393, "ft", "pp_414", "landing distance (50 ft) 2,393 ft"),
  vso=P(71, "kt", "aero_c414", "dirty (flaps down) stall 71 KIAS, clean 82 KIAS"))

T("C421", name="Cessna 421 Golden Eagle", variant="421C Golden Eagle (1976–85), 2 × Continental GTSIO-520-L/N 375 hp", kind="piston", n=2, fuel="avgas", turbo=True, press=True,
  eng=P(375, "hp", "wiki_types", "two Continental GTSIO-520-L/N of 375 hp each"),
  span=R(41.08, "ft", "wiki_types", "wing span 41 ft 1 in"),
  mtow=P(7450, "lb", "wiki_types", "maximum takeoff weight 7,450 lb (3,379 kg)"),
  ceil=P(30200, "ft", "aero_c421", "service ceiling 30,200 ft"),
  roc=P(1940, "fpm", "aero_c421", "rate of climb about 1,940 ft/min"),
  tas=P(240, "kt", "wiki_types", "cruise 240 kn at 25,000 ft, 75% power (AvWeb: 195–215 KTAS is realistic planning)"), cruise={"power": "75%", "alt_ft": 25000},
  to=P(2323, "ft", "aero_c421", "takeoff distance to 50 ft about 2,323 ft (708 m)"),
  ldg=P(2293, "ft", "aero_c421", "landing distance from 50 ft about 2,293 ft (699 m)"),
  vso_est=(74, "est: 421C class (414A 71 kt at 6,750 lb, scaled to 7,450 lb)"))

# ======================= turboprops ==========================================================
T("C208", name="Cessna 208 Caravan", variant="208B Grand Caravan EX, P&WC PT6A-140 867 shp", kind="turboprop", n=1, fuel="jet-a",
  eng=P(867, "shp", "tx_gcex", "Pratt & Whitney Canada PT6A-140, 867 shp"),
  span=P(52.08, "ft", "tx_gcex", "wingspan 52 ft 1 in (15.9 m)"),
  mtow=P(8807, "lb", "tx_gcex", "maximum takeoff weight 8,807 lb (MLW 8,500 lb)"),
  ceil=P(25000, "ft", "tx_gcex", "maximum operating altitude 25,000 ft"),
  roc=P(1275, "fpm", "tx_gcex", "maximum climb rate 1,275 fpm"),
  tas=P(185, "kt", "tx_gcex", "maximum cruise speed 185 ktas"), cruise={"power": "maximum cruise", "alt_ft": None},
  rng=P(912, "nm", "tx_gcex", "maximum range 912 nm"),
  to=P(2160, "ft", "tx_gcex", "takeoff distance 2,160 ft (ground roll 1,399 ft)"),
  ldg=P(1836, "ft", "tx_gcex", "landing distance 1,836 ft (ground roll 1,004 ft)"),
  vso=P(61, "kt", "tx_gcex", "stall speed 61 kcas"),
  notes=["ICAO C208 covers the 208 Caravan (675 shp, 8,000 lb, 186 ktas, same Textron site) and the 208B; the Grand Caravan EX is used."])

T("P46T", name="Piper PA-46 Meridian", variant="PA-46-500TP Meridian, P&WC PT6A-42A 500 shp", kind="turboprop", n=1, fuel="jet-a", press=True,
  eng=R(500, "shp", "pp_meridian", "PT6A-42A flat-rated 500 shp"),
  span=R(43.0, "ft", "pp_meridian", "wing span 43 ft"),
  mtow=P(5092, "lb", "pp_meridian", "max takeoff weight 5,092 lb (MLW 4,850 lb)"),
  ceil=P(30000, "ft", "aero_meridian", "max certified altitude 30,000 ft"),
  roc=P(1380, "fpm", "aero_meridian", "rate of climb at sea level 1,380 fpm (GlobalAir 1,556 fpm)"),
  tas=P(260, "kt", "pp_meridian", "top cruise 260 kt"), cruise={"power": "maximum cruise", "alt_ft": 30000},
  rng=P(1000, "nm", G, "range about 1,000 nm"),
  to=P(2000, "ft", G, "balanced field length 2,000 ft (treated as takeoff distance)"),
  ldg=P(1950, "ft", G, "landing distance 1,950 ft"),
  vso_est=(65, "est: PA-46 turboprop class (M350 58 kt at 4,340 lb, scaled to 5,092 lb)"))

T("M600", name="Piper M600", variant="M600 / M600 SLS, P&WC PT6A-42A 600 shp", kind="turboprop", n=1, fuel="jet-a", press=True,
  eng=P(600, "shp", "pp_m600", "PT6A-42A, 600 shp"),
  span=P(43.1, "ft", "pp_m600", "wing span 43.1 ft"),
  mtow=P(6000, "lb", "pp_m600", "max takeoff weight 6,000 lb"),
  ceil=P(30000, "ft", G, "service ceiling 30,000 ft"),
  roc=P(1556, "fpm", "pp_m600", "max. rate of climb 1,556 fpm"),
  tas=P(274, "kt", "pp_m600", "max cruise 274 KTAS"), cruise={"power": "maximum cruise", "alt_ft": 28000},
  rng=P(1484, "nm", "pp_m600", "range 1,484 nm at 184 KTAS (1,085 nm at max speed)"),
  to=P(2635, "ft", "pp_m600", "takeoff distance (50-ft obstacle) 2,635 ft"),
  ldg=P(2659, "ft", "pp_m600", "landing distance (50-ft obstacle) 2,659 ft"),
  vso_est=(67, "est: M600 class (PC-12 67 KIAS); no published figure found"))

T("TBM7", name="Daher TBM 700", variant="TBM 700 (A/B), P&WC PT6A-64 700 shp", kind="turboprop", n=1, fuel="jet-a", press=True,
  eng=R(700, "shp", G, "PT6A-64, 700 shp"),
  span=P(41.58, "ft", G, "wingspan 41 ft 7 in"),
  mtow=P(6579, "lb", "aggr_misc", "MTOW 6,579 lb (TBM 700/700B; 700C2: 7,394 lb)"),
  ceil=P(30000, "ft", G, "service ceiling 30,000 ft"),
  roc_est=(2000, "est: TBM 700 class (TBM 850 published 2,400 fpm with more power); no TBM 700 figure found"),
  tas=P(300, "kt", G, "maximum cruise about 300 kt"), cruise={"power": "maximum cruise", "alt_ft": 26000},
  rng=P(1460, "nm", "aggr_misc", "range 1,460 nm with IFR reserves (sources: 1,350–1,550 nm)"),
  to=P(2153, "ft", G, "takeoff distance 2,153 ft (700C page)"),
  ldg=P(2133, "ft", G, "landing distance 2,133 ft (700B page)"),
  vso_est=(65, "est: TBM class; no published figure found"),
  notes=["Only aggregator data found — weak."])

T("TBM8", name="Daher TBM 850", variant="TBM 850, P&WC PT6A-66D 850 shp", kind="turboprop", n=1, fuel="jet-a", press=True,
  eng=R(850, "shp", "aero_tbm850", "PT6A-66D, 850 shp (flat-rated)"),
  span=P(12.68, "m", "aero_tbm850", "wingspan 41 ft 7 in (12.68 m)"),
  mtow=P(7394, "lb", "aero_tbm850", "MTOW about 7,394 lb (3,354 kg)"),
  ceil=P(31000, "ft", G, "ceiling 31,000 ft"),
  roc_est=(2400, "est: TBM 850 class; no confirmed published figure found"),
  tas=P(320, "kt", G, "maximum cruise about 320 kt"), cruise={"power": "maximum cruise", "alt_ft": 26000},
  rng=P(1518, "nm", "aero_tbm850", "range 2,810 km at long-range cruise (about 1,518 nm)"),
  to=P(3022, "ft", "aggr_misc", "balanced field length 3,022 ft (treated as takeoff distance)"),
  ldg=P(2864, "ft", "aggr_misc", "landing distance 2,864 ft"),
  vso_est=(65, "est: TBM class; no published figure found"))

T("PC12", name="Pilatus PC-12", variant="PC-12 NGX, P&WC PT6E-67XP 1,200 shp", kind="turboprop", n=1, fuel="jet-a", press=True,
  eng=R(1200, "shp", "pilatus_pc12ngx", "PT6E-67XP, about 1,200 shp"),
  span=P(53.33, "ft", "pilatus_pc12ngx", "wingspan 53 ft 4 in (16.28 m)"),
  mtow=P(10450, "lb", "pilatus_pc12ngx", "MTOW 10,450 lb (4,740 kg)"),
  ceil=P(30000, "ft", "pilatus_pc12ngx", "certified altitude 30,000 ft"),
  roc=P(1920, "fpm", "pilatus_pc12ngx", "rate of climb 1,920 ft/min at MTOW, sea level"),
  tas=P(290, "kt", "pilatus_pc12ngx", "max cruise 290 KTAS at FL220"), cruise={"power": "maximum cruise", "alt_ft": 22000},
  rng=P(1765, "nm", "pilatus_pc12ngx", "max range 1,765 nm (Pilatus PC-12 page)"),
  to=P(2485, "ft", "pilatus_pc12ngx", "take-off distance over 50 ft 2,485 ft at MTOW, SL, ISA"),
  ldg=P(2170, "ft", "pilatus_pc12ngx", "landing distance over 50 ft 2,170 ft at MLW, SL"),
  vso=P(67, "kt", "pilatus_pc12ngx", "stall speed, landing configuration, MLW 67 KIAS"))

T("PC6T", name="Pilatus PC-6 Porter", variant="PC-6/B2-H4 Turbo Porter, P&WC PT6A-27 550 shp", kind="turboprop", n=1, fuel="jet-a",
  eng=P(550, "shp", "fg_pc6", "PT6A-27, 550 shp"),
  span=R(15.87, "m", "fg_pc6", "wing span 15.87 m"),
  mtow=P(2800, "kg", "fg_pc6", "H4: maximum take-off weight 2,800 kg"),
  ceil=R(25000, "ft", "fg_pc6", "maximum operating altitude 25,000 ft (one source gives about 26,900 ft service ceiling)"),
  roc_est=(1000, "est: no published figure found; Turbo Porter class at 2,800 kg"),
  tas_est=(115, "est: published maximum speeds range 125–151 kt; typical cruise about 115 KTAS"),
  to_gr=P(197, "m", "fg_pc6", "flight test: take-off ground roll 197 m at 2,800 kg"),
  ldg_gr=P(127, "m", "fg_pc6", "flight test: landing roll 127 m"),
  vso_est=(50, "est: STOL class; no published figure found"),
  notes=["Weak: few published figures; cruise speed and climb estimated."])

T("BE9L", name="Beechcraft King Air 90", variant="King Air C90GTx, 2 × P&WC PT6A-135A 550 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(550, "shp", "aggr_misc", "PT6A-135A limited to 550 shp (flyradius)"),
  span=P(16.36, "m", "aggr_misc", "wingspan 16.36 m (jetvip)"),
  mtow=P(10485, "lb", "bjt_c90gtx", "max takeoff weight 10,485 lb"),
  ceil=P(30000, "ft", "bjt_c90gtx", "service ceiling 30,000 ft"),
  roc_est=(1900, "est: no published figure found; C90 class"),
  tas=P(272, "kt", "bjt_c90gtx", "max cruise 272–274 KTAS"), cruise={"power": "maximum cruise", "alt_ft": None},
  rng=P(903, "nm", "bjt_c90gtx", "range 903 nm"),
  to=P(3888, "ft", "bjt_c90gtx", "balanced field length 3,888 ft (treated as takeoff distance)"),
  ldg=P(3056, "ft", "aggr_misc", "landing distance 3,056 ft (aircraftcostcalculator)"),
  vso_est=(76, "est: C90 class (King Air 260 80 kcas at 12,500 lb, scaled to 10,485 lb)"))

T("BE20", name="Beechcraft King Air 200", variant="King Air 260 (B200 series), 2 × P&WC PT6A-52 850 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(850, "shp", "tx_ka260", "PT6A-52, 850 shp"),
  span=P(57.92, "ft", "tx_ka260", "wingspan 57 ft 11 in (17.65 m)"),
  mtow=P(12500, "lb", "tx_ka260", "maximum takeoff weight 12,500 lb"),
  ceil=P(35000, "ft", "tx_ka260", "maximum operating altitude 35,000 ft"),
  roc=P(2437, "fpm", "tx_ka260", "maximum climb rate 2,437 fpm"),
  tas=P(310, "kt", "tx_ka260", "maximum cruise speed 310 ktas"), cruise={"power": "maximum cruise", "alt_ft": None},
  rng=P(1720, "nm", "tx_ka260", "maximum range 1,720 nm"),
  to=P(2111, "ft", "tx_ka260", "takeoff distance 2,111 ft (ground roll 1,715 ft)"),
  ldg=P(2845, "ft", "tx_ka260", "landing distance 2,845 ft (ground roll 1,750 ft)"),
  vso=P(80, "kt", "tx_ka260", "stall speed 80 kcas"))

T("B350", name="Beechcraft King Air 350", variant="King Air 360 (350 series), 2 × P&WC PT6A-60A 1,050 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(1050, "shp", "tx_ka360", "PT6A-60A, 1,050 shp"),
  span=P(57.92, "ft", "tx_ka360", "wingspan 57 ft 11 in (17.65 m)"),
  mtow=P(15000, "lb", "tx_ka360", "maximum takeoff weight 15,000 lb"),
  ceil=P(35000, "ft", "tx_ka360", "maximum operating altitude 35,000 ft"),
  roc=P(2700, "fpm", "tx_ka360", "maximum climb rate 2,700 fpm"),
  tas=P(312, "kt", "tx_ka360", "maximum cruise speed 312 ktas"), cruise={"power": "maximum cruise", "alt_ft": None},
  rng=P(1806, "nm", "tx_ka360", "maximum range 1,806 nm"),
  to=P(3300, "ft", "tx_ka360", "takeoff field length 3,300 ft"),
  ldg=P(2692, "ft", "tx_ka360", "landing distance 2,692 ft"),
  vso=P(81, "kt", "tx_ka360", "stall speed 81 kcas"))

T("C425", name="Cessna 425 Conquest I", variant="425 Conquest I, 2 × P&WC PT6A-112 450 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(450, "shp", "aggr_misc", "PT6A-112, 450 shp each (aerocorner)"),
  span=R(44.13, "ft", "fi_c425", "wing span 44 ft 1.5 in"),
  mtow=P(8600, "lb", "fi_c425", "max takeoff weight 8,600 lb (3,901 kg)"),
  ceil=P(34700, "ft", "aggr_misc", "service ceiling 34,700 ft (aerocorner; flugzeuginfo 33,400 ft)"),
  roc=P(1861, "fpm", "aggr_misc", "rate of climb 1,861 ft/min (aerocorner)"),
  tas=P(265, "kt", "aggr_misc", "maximum cruise 265 kt (aerocorner, jettly)"), cruise={"power": "maximum cruise", "alt_ft": None},
  to=P(2450, "ft", "aggr_misc", "takeoff distance 2,450 ft (basis not stated)"),
  ldg=P(2150, "ft", "aggr_misc", "landing distance 2,150 ft (basis not stated)"),
  vso_est=(75, "est: Conquest class; no published figure found"),
  notes=["Only aggregator / reference data found — weak."])

T("C441", name="Cessna 441 Conquest II", variant="441 Conquest II, 2 × Garrett TPE331-8 636 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(636, "shp", "fi_c441", "Garrett TPE331-8, 636 shp each"),
  span=R(49.33, "ft", "fi_c441", "wing span 49 ft 4 in"),
  mtow=P(9850, "lb", "fi_c441", "maximum takeoff weight 9,850 lb (4,468 kg)"),
  ceil=P(35000, "ft", "wiki_types", "service ceiling 35,000 ft (FL330 with -8 engines per one source)"),
  roc=P(2435, "fpm", "wiki_types", "rate of climb 2,435 ft/min (engine version unconfirmed)"),
  tas=P(259, "kt", "wiki_types", "cruise speed 259 kn at 35,000 ft (TPE331-8; -10 conversions cruise ~300 kt)"), cruise={"power": "cruise", "alt_ft": 35000},
  to_gr=P(1785, "ft", "wiki_types", "takeoff ground roll 1,785 ft (544 m)"),
  vso_est=(80, "est: Conquest II class; no published figure found"),
  ldg_est=(2000, "est: no published landing distance found; similar to King Air 200 class at lower weight"),
  ff=P(480, "lbh", "wiki_types", "about 480 lb/h at FL290 at 316 KTAS (-10 engines)"), ff_meta={"setting": "high-speed cruise, TPE331-10 conversion", "alt_ft": 29000, "tas_kt": 316},
  notes=["Weak: data mixes the original -8 engines and the common -10 conversion."])

T("DHC6", name="DHC-6 Twin Otter", variant="DHC-6 Series 300, 2 × P&WC PT6A-27 620 shp", kind="turboprop", n=2, fuel="jet-a",
  eng=R(620, "shp", "aero_dhc6", "PT6A-27, 620 shp each (flat-rated)"),
  span=R(65.0, "ft", "aero_dhc6", "wing span 65 ft"),
  mtow=P(12500, "lb", "aero_dhc6", "maximum takeoff weight 12,500 lb"),
  ceil=P(26700, "ft", "aero_dhc6", "service ceiling 26,700 ft"),
  roc=P(1600, "fpm", "aero_dhc6", "rate of climb 1,600 ft/min"),
  tas=P(176, "kt", "aero_dhc6", "maximum cruise 202 mph (176 kt) at 10,000 ft (economical 172 mph)"), cruise={"power": "maximum cruise", "alt_ft": 10000},
  rng=P(775, "nm", G, "maximum range 775 nm"),
  to_gr=P(860, "ft", "aero_dhc6", "takeoff run 860 ft"),
  ldg_gr=P(950, "ft", "aero_dhc6", "landing run 950 ft"),
  vso_est=(58, "est: Twin Otter STOL class; no published figure found"))

T("P180", name="Piaggio P.180 Avanti", variant="P.180 Avanti EVO, 2 × P&WC PT6A-66B 850 shp", kind="turboprop", n=2, fuel="jet-a", press=True,
  eng=P(850, "shp", "piaggio_evo", "PT6A-66B, 850 SHP each"),
  span=R(46.0, "ft", "piaggio_evo", "wing span 46 ft 0.5 in (14.03 m)"),
  mtow=P(12100, "lb", "piaggio_evo", "MTOW 12,100 lb (5,488 kg)"),
  ceil=P(41000, "ft", "piaggio_evo", "service ceiling 41,000 ft"),
  roc=P(2770, "fpm", "piaggio_evo", "rate of climb (MTOW 12,100 lb) 2,770 fpm"),
  tas=P(402, "kt", "piaggio_evo", "maximum speed 402 KTAS at 31,000 ft ISA (MMO 0.70)"), cruise={"power": "maximum cruise", "alt_ft": 31000},
  rng=P(1490, "nm", "piaggio_evo", "max range (NBAA IFR, standard configuration) 1,490 nm (1,770 nm increased-range)"),
  to=P(3190, "ft", "piaggio_evo", "take-off distance (SL, ISA, to clear 50 ft) 972 m / 3,190 ft"),
  ldg=P(3282, "ft", "piaggio_evo", "landing distance (SL, ISA, 50 ft, MLW, no reverse) 1,000 m / 3,282 ft"),
  vso_est=(90, "est: Avanti class; no published figure found"))

# ======================= business jets =======================================================
# thrust per engine; vref_est = (value, note) when no published Vref
T("HDJT", name="HondaJet", variant="HondaJet Elite II, 2 × GE Honda HF120", kind="jet", n=2, fuel="jet-a",
  eng=R(2095, "lbf", "honda_perf", "GE Honda HF120, 2,095 lbf each"),
  span=R(39.75, "ft", "honda_perf", "wing span 39 ft 9 in (12.12 m)"),
  mtow=P(11100, "lb", "honda_perf", "MTOW 11,100 lb (Elite II, launch press coverage)"),
  ceil=P(43000, "ft", "honda_perf", "maximum cruise altitude FL430"),
  roc=P(4100, "fpm", "honda_perf", "rate of climb 4,100 ft/min"),
  tas=P(422, "kt", "honda_perf", "maximum cruise speed 422 KTAS at FL300"), cruise={"alt_ft": 30000},
  rng=P(1547, "nm", "honda_perf", "NBAA IFR range, 4 occupants: 1,547 nm"),
  to=R(3491, "ft", "honda_perf", "takeoff distance 3,491 ft (SL, ISA, MTOW)"),
  ldg=R(2699, "ft", "honda_perf", "landing distance 2,699 ft"),
  vref_est=110)

T("E50P", name="Embraer Phenom 100", variant="Phenom 100EX, 2 × P&WC PW617F1-E", kind="jet", n=2, fuel="jet-a",
  eng=P(1730, "lbf", "embraer_p100ex", "PW617F1-E, 1,730 lbf each (flat-rated ISA + 8 °C)"),
  span=P(40.33, "ft", "embraer_p100ex", "wingspan 40 ft 4 in (12.30 m)"),
  mtow=P(10703, "lb", "aggr_misc", "MTOM 4,855 kg / 10,703 lb (MJET, aircraft.com)"),
  ceil=P(41000, "ft", "embraer_p100ex", "maximum operating altitude 41,000 ft"),
  tas=P(406, "kt", "embraer_p100ex", "high-speed cruise 406 KTAS (MMO 0.70)"), cruise={},
  rng=P(1178, "nm", "embraer_p100ex", "long-range cruise range 1,178 nm (4 occupants, NBAA IFR reserves)"),
  to=P(3190, "ft", "aggr_misc", "takeoff distance 3,190 ft (SL, ISA, MTOW)"),
  ldg=P(2430, "ft", G, "landing distance 2,430 ft"),
  vref_est=100)

T("E55P", name="Embraer Phenom 300", variant="Phenom 300E, 2 × P&WC PW535E1", kind="jet", n=2, fuel="jet-a",
  eng=P(3478, "lbf", "embraer_p300e", "PW535E1, 3,478 lbf each (flat-rated ISA + 15 °C)"),
  span=P(52.17, "ft", "embraer_p300e", "wingspan 52 ft 2 in"),
  mtow=P(18551, "lb", "avweek_p300e", "MTOW 18,551 lb with PW535E1 engines"),
  ceil=P(45000, "ft", "embraer_p300e", "maximum operating altitude 45,000 ft"),
  tas=P(464, "kt", "embraer_p300e", "high-speed cruise 464 kt (MMO 0.80)"), cruise={},
  rng=P(2010, "nm", "embraer_p300e", "long-range cruise range 2,010 nm (NBAA IFR, 100 nm alternate)"),
  to=P(3209, "ft", "embraer_p300e", "takeoff distance 3,209 ft (MTOW, SL, ISA)"),
  ldg=P(2212, "ft", "embraer_p300e", "landing distance 2,212 ft unfactored (5 occupants, NBAA IFR reserves)"),
  vref_est=112)

T("C525", name="Cessna Citation CJ1 / M2", variant="Citation M2 Gen2 (525), 2 × Williams FJ44-1AP-21", kind="jet", n=2, fuel="jet-a",
  eng=P(1965, "lbf", "tx_m2", "FJ44-1AP-21, 1,965 lb (8.74 kN)"),
  span=P(47.25, "ft", "tx_m2", "wingspan 47 ft 3 in (14.39 m)"),
  mtow=P(10700, "lb", "tx_m2", "maximum takeoff weight 10,700 lb (MLW 9,900 lb)"),
  ceil=P(41000, "ft", "tx_m2", "maximum operating altitude 41,000 ft"),
  roc=P(3698, "fpm", "tx_m2", "maximum climb rate 3,698 fpm"),
  tas=P(404, "kt", "tx_m2", "maximum cruise speed 404 ktas (max limit speed M0.71)"), cruise={},
  rng=P(1550, "nm", "tx_m2", "maximum range 1,550 nm"),
  to=P(3210, "ft", "tx_m2", "takeoff field length 3,210 ft"),
  ldg=P(2590, "ft", "tx_m2", "landing distance 2,590 ft"),
  vref_est=108,
  notes=["ICAO C525 covers the CitationJet, CJ1/CJ1+ and M2; the current M2 Gen2 is used."])

T("C25A", name="Cessna Citation CJ2", variant="Citation CJ2+ (525A), 2 × Williams FJ44-3A-24", kind="jet", n=2, fuel="jet-a",
  eng=P(2490, "lbf", "rr_cj2", "FJ44-3A-24, 2,490 lb each (one source: 2,400 lb)"),
  span=P(49.83, "ft", "rr_cj2", "wingspan 49 ft 10 in (CJ2)"),
  mtow=P(12500, "lb", "rr_cj2", "max takeoff weight 12,500 lb"),
  ceil=P(45000, "ft", "rr_cj2", "ceiling 45,000 ft"),
  tas=P(413, "kt", "rr_cj2", "maximum cruise 413 kt (RocketRoute 418 kt)"), cruise={},
  rng=P(1550, "nm", "rr_cj2", "NBAA IFR range, 4 passengers 1,550 nm (sources 1,509–1,613 nm)"),
  to=P(3360, "ft", "rr_cj2", "takeoff distance 3,360 ft (SL, ISA, MTOW)"),
  ldg=P(2980, "ft", "rr_cj2", "landing distance 2,980 ft (sources 2,590–2,980 ft)"),
  vref_est=110)

T("C25B", name="Cessna Citation CJ3", variant="Citation CJ3 Gen3 / CJ3+ (525B), 2 × Williams FJ44-3A", kind="jet", n=2, fuel="jet-a",
  eng=P(2820, "lbf", "tx_cj3", "FJ44-3A, 2,820 lb (12.54 kN)"),
  span=P(53.33, "ft", "tx_cj3", "wingspan 53 ft 4 in (16.26 m)"),
  mtow=P(13870, "lb", "tx_cj3", "maximum takeoff weight 13,870 lb (MLW 12,750 lb)"),
  ceil=P(45000, "ft", "tx_cj3", "maximum operating altitude 45,000 ft"),
  roc=P(4478, "fpm", "tx_cj3", "maximum climb rate 4,478 fpm"),
  tas=P(416, "kt", "tx_cj3", "maximum cruise speed 416 ktas (max limit speed M0.737)"), cruise={},
  rng=P(2040, "nm", "tx_cj3", "maximum range 2,040 nm"),
  to=P(3180, "ft", "tx_cj3", "takeoff field length 3,180 ft"),
  ldg=P(2770, "ft", "tx_cj3", "landing distance 2,770 ft"),
  vref_est=112)

T("PRM1", name="Beechcraft Premier I", variant="Premier IA, 2 × Williams FJ44-2A", kind="jet", n=2, fuel="jet-a",
  eng=P(2300, "lbf", "aopa_premier", "FJ44-2A, 2,300 lbst each"),
  span=P(44.5, "ft", "aopa_premier", "wing span 44 ft 6 in"),
  mtow=P(12500, "lb", "aopa_premier", "maximum takeoff weight 12,500 lb (ramp 12,590 lb)"),
  ceil=P(41000, "ft", "aopa_premier", "maximum operating altitude 41,000 ft"),
  tas=P(451, "kt", "aopa_premier", "451 KTAS at 33,000 ft"), cruise={"alt_ft": 33000},
  rng=P(1350, "nm", "aopa_premier", "1,350 nm at 451 KTAS (other sources 1,400–1,460 nm)"),
  to=P(3792, "ft", "aopa_premier", "takeoff distance 3,792 ft (max gross, SL, 15 °C)"),
  ldg=P(3125, "ft", "aggr_misc", "landing distance 3,125 ft (Guardian Jet; conditions not stated)"),
  vref_est=120)

T("C560", name="Cessna Citation V / Ultra / Encore", variant="Citation Encore+ (560), 2 × P&WC PW535B", kind="jet", n=2, fuel="jet-a",
  eng=R(3400, "lbf", "wiki_types", "PW535B, 3,400 lbf each"),
  span=P(16.49, "m", "aggr_misc", "wingspan 16.49 m (jetvip)"),
  mtow=P(16630, "lb", "wiki_types", "Encore+ MTOW raised to 16,630 lb (7,544 kg)"),
  ceil=R(45000, "ft", "wiki_types", "maximum operating altitude 45,000 ft"),
  tas=P(430, "kt", G, "normal cruise 430 kt"), cruise={},
  rng=P(1792, "nm", G, "max range 1,792 nm (Wikipedia: 1,800 nm at 390 KTAS)"),
  to=P(3520, "ft", "wiki_types", "takeoff distance 3,520 ft (1,070 m), ISA"),
  ldg=P(2507, "ft", "aggr_misc", "landing distance 764 m (jetvip; conditions not stated)"),
  vref_est=108)

T("C56X", name="Cessna Citation Excel / XLS", variant="Citation XLS Gen2 (560XL), 2 × P&WC PW545D", kind="jet", n=2, fuel="jet-a",
  eng=P(4218, "lbf", "tx_xls", "PW545D, 4,218 lb (18.76 kN)"),
  span=P(55.67, "ft", "tx_xls", "wingspan 55 ft 8 in (16.97 m)"),
  mtow=P(20500, "lb", "tx_xls", "maximum takeoff weight 20,500 lb (MLW 18,700 lb)"),
  ceil=P(45000, "ft", "tx_xls", "maximum operating altitude 45,000 ft"),
  notes=["Textron publishes a direct climb to FL430 in 26 min; the jet climb-rate fractions (rule JROC) are calibrated on it."],
  tas=P(441, "kt", "tx_xls", "maximum cruise speed 441 ktas (max limit speed M0.75)"), cruise={},
  rng=P(1940, "nm", "tx_xls", "4-passenger range 1,940 nm at HSC, NBAA IFR reserves"),
  to=P(3800, "ft", "tx_xls", "takeoff field length 3,800 ft (SL, MTOW)"),
  ldg=P(3180, "ft", "tx_xls", "landing distance 3,180 ft"),
  vref_est=110)

T("C680", name="Cessna Citation Sovereign", variant="Citation Sovereign+ (680), 2 × P&WC PW306D", kind="jet", n=2, fuel="jet-a",
  eng=P(5852, "lbf", "wiki_types", "PW306D, 5,852 lbf (26.03 kN)"),
  span=P(72.33, "ft", "aggr_misc", "wingspan 72 ft 4 in (22.04 m) (aircharteradvisors)"),
  mtow=P(30775, "lb", "jetcraft", "MTOW 30,775 lb (13,959 kg)"),
  ceil=P(47000, "ft", "jetcraft", "maximum operating altitude 47,000 ft"),
  tas=P(448, "kt", "jetcraft", "maximum cruise 448 kt (Wikipedia top speed 458 kt)"), cruise={},
  rng=P(3200, "nm", "avweek_sov", "range 3,200 nm"),
  to=P(3530, "ft", "jetcraft", "takeoff distance 3,530 ft (MTOW, SL, ISA)"),
  ldg=P(2144, "ft", "jetcraft", "landing distance 2,144 ft (653 m)"),
  vref_est=110)

T("C750", name="Cessna Citation X", variant="Citation X (750, 1996–2012), 2 × Rolls-Royce AE3007C", kind="jet", n=2, fuel="jet-a",
  eng=R(6442, "lbf", "jetcraft", "Rolls-Royce AE3007C, 6,442 lbf each"),
  span=R(63.92, "ft", "jetcraft", "wingspan 63 ft 11 in (19.48 m; X+ 21.09 m)"),
  mtow=P(36100, "lb", "jetcraft", "maximum takeoff weight 36,100 lb (MLW 31,800 lb)"),
  ceil=P(51000, "ft", "jetcraft", "maximum operating altitude 51,000 ft"),
  tas=P(514, "kt", "jetcraft", "maximum cruise 514 kt (long-range 470 kt)"), cruise={},
  rng=P(3380, "nm", "jetcraft", "maximum range 3,380 nm"),
  to=P(5140, "ft", "jetcraft", "takeoff distance 5,140 ft (SL, ISA, MTOW)"),
  ldg=P(2730, "ft", "jetcraft", "landing distance 2,730 ft (SL, ISA, MLW)"),
  vref_est=130)

T("LJ45", name="Learjet 45", variant="Learjet 45XR, 2 × Honeywell TFE731-20BR", kind="jet", n=2, fuel="jet-a",
  eng=P(3500, "lbf", "fr_lj45", "TFE731-20BR, 3,500 lbf each (flat-rated ISA + 25 °C)"),
  span=P(14.58, "m", "skybrary", "wingspan 14.58 m"),
  mtow=P(21500, "lb", "fr_lj45", "MTOW 21,500 lb"),
  ceil=P(51000, "ft", "fr_lj45", "service ceiling 51,000 ft"),
  tas=P(465, "kt", "fr_lj45", "maximum cruise 465 kt (long-range about 432–437 kt)"), cruise={},
  rng=P(2049, "nm", "fr_lj45", "range about 2,049 nm (IFR reserves, 4 passengers)"),
  to=P(5040, "ft", "fr_lj45", "takeoff distance 5,040 ft (SL, ISA, MTOW)"),
  ldg=P(2660, "ft", "fr_lj45", "landing distance 2,660 ft (SL, ISA, MLW)"),
  vref_est=125)

T("LJ60", name="Learjet 60", variant="Learjet 60XR, 2 × P&WC PW305A", kind="jet", n=2, fuel="jet-a",
  eng=P(4600, "lbf", "aopa_lj60xr", "PW305A, 4,600 lbf each"),
  span=P(43.75, "ft", "aggr_misc", "wingspan 43 ft 9 in (13.36 m) (avpay)"),
  mtow=P(23500, "lb", "jetcraft", "maximum takeoff weight 23,500 lb"),
  ceil=P(51000, "ft", "jetcraft", "service ceiling 51,000 ft"),
  tas=P(465, "kt", "aopa_lj60xr", "maximum cruise 465 ktas (long-range 426 KTAS / M0.74)"), cruise={},
  rng=P(2451, "nm", "aopa_lj60xr", "max range 2,451 nm"),
  to=P(5450, "ft", "jetcraft", "takeoff distance 5,450 ft (SL, ISA, MTOW)"),
  ldg=P(3420, "ft", "aopa_lj60xr", "landing distance 3,420 ft (Jetcraft: 3,049 ft at MLW)"),
  vref_est=130)

T("CL30", name="Bombardier Challenger 300", variant="Challenger 300, 2 × Honeywell HTF7000", kind="jet", n=2, fuel="jet-a",
  eng=P(6826, "lbf", "aggr_misc", "HTF7000, about 6,826 lbf (30.4 kN) each"),
  span=P(63.83, "ft", "aggr_misc", "wingspan 63 ft 10 in"),
  mtow=P(38850, "lb", G, "MTOW 38,850 lb"),
  ceil=R(45000, "ft", G, "maximum operating altitude 45,000 ft"),
  tas=P(470, "kt", "aggr_misc", "maximum cruise about 470 kt (M0.82)"), cruise={},
  rng=P(3100, "nm", "aggr_misc", "maximum range about 3,100 nm"),
  to=P(4810, "ft", G, "balanced field length 4,810 ft"),
  ldg=P(2600, "ft", "aggr_misc", "landing distance 2,600 ft (aerocorner)"),
  vref_est=120)

T("CL35", name="Bombardier Challenger 350", variant="Challenger 350, 2 × Honeywell HTF7350", kind="jet", n=2, fuel="jet-a",
  eng=P(7323, "lbf", "bbd_cl350", "HTF7350, 7,323 lbf (33 kN), flat-rated ISA + 15 °C"),
  span=P(69.0, "ft", "bbd_cl350", "wing span 69 ft 0 in (21.0 m)"),
  mtow=P(40600, "lb", "aggr_misc", "MTOW 40,600 lb (18,416 kg)"),
  ceil=P(45000, "ft", "bbd_cl350", "maximum operating altitude 45,000 ft"),
  mach=P(0.82, "mach", "bbd_cl350", "high-speed cruise M0.82 (typical M0.80, top M0.83)"), cruise={},
  rng=P(3200, "nm", "bbd_cl350", "maximum range 3,200 nm"),
  to=P(4835, "ft", "bbd_cl350", "takeoff distance 4,835 ft (SL, ISA, MTOW)"),
  ldg=P(2364, "ft", "bbd_cl350", "landing distance 2,364 ft (SL, ISA, typical weight)"),
  vref_est=118)

T("CL60", name="Bombardier Challenger 600 / 604", variant="Challenger 605, 2 × GE CF34-3B", kind="jet", n=2, fuel="jet-a",
  eng=P(8729, "lbf", "jetcraft", "CF34-3B, 8,729 lb each"),
  span=P(64.33, "ft", "jetcraft", "wingspan 64 ft 4 in (19.6 m)"),
  mtow=P(48200, "lb", "jetcraft", "maximum takeoff weight 48,200 lb"),
  ceil=P(41000, "ft", "jetcraft", "maximum operating altitude 41,000 ft"),
  tas=P(470, "kt", "jetcraft", "maximum cruise 470 kt (long-range 424 kt)"), cruise={},
  rng=P(4047, "nm", "jetcraft", "NBAA IFR, 4 passengers 4,047 nm"),
  to=P(5840, "ft", "jetcraft", "takeoff 1,780 m (SL, ISA, MTOW)"),
  ldg=P(2359, "ft", "jetcraft", "landing 719 m (SL, ISA, MLW)"),
  vref_est=125)

T("F2TH", name="Dassault Falcon 2000", variant="Falcon 2000LXS, 2 × P&WC PW308C", kind="jet", n=2, fuel="jet-a",
  eng=P(7000, "lbf", "dassault_2000lxs", "PW308C, 7,000 lb (31.14 kN) SL ISA"),
  span=P(21.38, "m", "dassault_2000lxs", "wingspan 70 ft 2 in / 21.38 m"),
  mtow=P(42800, "lb", "dassault_2000lxs", "MTOW 42,800 lb (MLW 39,300 lb)"),
  ceil=P(47000, "ft", "dassault_2000lxs", "max. certified altitude 47,000 ft"),
  mach=P(0.80, "mach", "dassault_2000lxs", "range quoted cruising at M0.80 (MMO 0.86)"), cruise={},
  rng=P(4000, "nm", "dassault_2000lxs", "range 4,000 nm (8 pax, NBAA IFR reserves)"),
  to=P(4675, "ft", "dassault_2000lxs", "takeoff distance 4,675 ft (MTOW, SL, ISA)"),
  ldg=P(2260, "ft", "dassault_2000lxs", "landing distance 2,260 ft (6 pax, 2 crew, NBAA IFR reserves)"),
  vref=P(107, "kt", "ain_2000lxs", "Vref 107 kt (pre-certification estimate)"))

T("F900", name="Dassault Falcon 900", variant="Falcon 900LX, 3 × Honeywell TFE731-60", kind="jet", n=3, fuel="jet-a",
  eng=P(5000, "lbf", "aggr_misc", "TFE731-60, 5,000 lb each (businessaviation.aero)"),
  span=P(70.17, "ft", "aggr_misc", "wingspan 70 ft 2 in (21.39 m)"),
  mtow=R(49000, "lb", "dassault_900lx", "MTOW 49,000 lb"),
  ceil=P(51000, "ft", "dassault_900lx", "maximum certified altitude 51,000 ft"),
  mach_est=(0.80, "est: typical long-range cruise of the Falcon family (2000LXS range is quoted at M0.80); MMO 0.87"),
  rng=P(4750, "nm", "dassault_900lx", "range 4,750 nm (8 pax, NBAA IFR reserves)"),
  to=P(5360, "ft", "dassault_900lx", "takeoff distance 5,360 ft (MTOW, SL, ISA)"),
  ldg=P(2415, "ft", "dassault_900lx", "unfactored landing distance 2,415 ft (typical landing weight)"),
  vref=P(110, "kt", "dassault_900lx", "Vref 110 KIAS (typical landing weight)"))

T("FA7X", name="Dassault Falcon 7X", variant="Falcon 7X, 3 × P&WC PW307A", kind="jet", n=3, fuel="jet-a",
  eng=P(6402, "lbf", "aggr_misc", "PW307A, 6,402 lb each (businessaviation.aero)"),
  span=P(26.21, "m", "aggr_misc", "wing span 26.21 m (CAT Aviation factsheet)"),
  mtow=P(70000, "lb", "jetcraft", "MTOW 70,000 lb (31,751 kg)"),
  ceil=P(51000, "ft", "jetcraft", "ceiling 51,000 ft"),
  mach=P(0.80, "mach", "jetcraft", "long-range cruise M0.80 / 459 kt (MMO 0.90)"), cruise={},
  rng=P(5950, "nm", "aggr_misc", "max range 5,950 nm (CAT Aviation factsheet; Jetcraft 5,840 nm)"),
  to=P(5760, "ft", "jetcraft", "takeoff distance 5,760 ft (1,739 m)"),
  ldg=R(2070, "ft", "jetcraft", "landing distance about 2,070 ft (Dassault typical-weight figure)"),
  vref_est=105)

T("GLF4", name="Gulfstream IV", variant="Gulfstream IV-SP, 2 × Rolls-Royce Tay 611-8", kind="jet", n=2, fuel="jet-a",
  eng=R(13850, "lbf", "wiki_types", "Tay 611-8, 13,850 lbf each"),
  span=P(77.83, "ft", "wiki_types", "wingspan 77 ft 10 in (23.72 m)"),
  mtow=P(74600, "lb", "wiki_types", "MTOW 74,600 lb (33,838 kg) for GIV-SP (also NOAA, GlobalAir)"),
  ceil=P(45000, "ft", "wiki_types", "ceiling 45,000 ft"),
  mach=P(0.80, "mach", "wiki_types", "cruise M0.80–0.85; lower bound used"), cruise={},
  rng=P(3880, "nm", G, "normal range 3,880 nm (maximum 4,166 nm; NOAA 3,600 nm)"),
  to=P(5450, "ft", G, "takeoff distance 5,450 ft (BFL 5,700 ft)"),
  ldg=R(3190, "ft", "wiki_types", "landing distance about 3,190 ft"),
  vref_est=130)

T("GLF5", name="Gulfstream V", variant="Gulfstream G550 (GV-SP), 2 × Rolls-Royce BR710", kind="jet", n=2, fuel="jet-a",
  eng=P(15385, "lbf", "aggr_misc", "BR710, 15,385 lbf each"),
  span=P(28.5, "m", "aggr_misc", "wingspan 28.5 m"),
  mtow=P(91000, "lb", "aggr_misc", "MTOW 91,000 lb"),
  ceil=P(51000, "ft", "aggr_misc", "ceiling 51,000 ft"),
  mach_est=(0.80, "est: Gulfstream long-range cruise M0.80 (459 kt quoted with the 6,500 nm figure)"),
  rng=P(6750, "nm", "aggr_misc", "range 6,750 nm"),
  to=R(5910, "ft", "wiki_types", "takeoff distance 5,910 ft (SL, ISA, MTOW)"),
  ldg=R(2770, "ft", "wiki_types", "landing distance 2,770 ft"),
  vref_est=125,
  notes=["ICAO GLF5 covers the GV and G550; G550 figures used."])

T("GLEX", name="Bombardier Global Express", variant="Global 6000 (BD-700-1A10), 2 × Rolls-Royce BR710A2-20", kind="jet", n=2, fuel="jet-a",
  eng=P(14750, "lbf", "bbd_g6000", "BR710A2-20, 14,750 lbf (65.6 kN), flat-rated ISA + 20 °C"),
  span=P(94.0, "ft", "bbd_g6000", "wing span 94 ft (28.7 m)"),
  mtow=P(99500, "lb", "bbd_g6000", "maximum takeoff weight 99,500 lb (45,132 kg)"),
  ceil=R(51000, "ft", "bbd_g6000", "maximum operating altitude 51,000 ft"),
  mach=P(0.85, "mach", "bbd_g6000", "typical cruise M0.85 (high-speed M0.88, top M0.89)"), cruise={},
  rng=P(6000, "nm", "bbd_g6000", "maximum range 6,000 nm (M0.85, 8 pax, 4 crew, NBAA IFR reserves)"),
  to=P(6476, "ft", "bbd_g6000", "takeoff distance 6,476 ft (SL, ISA, MTOW)"),
  ldg=P(2236, "ft", "bbd_g6000", "landing distance 2,236 ft (SL, ISA, typical weight)"),
  vref_est=115,
  notes=["ICAO GLEX covers Global Express/XRS/5000/6000/6500; Global 6000 figures used."])

# ----------------------------------------------------------------------------------------------
# Builder
# ----------------------------------------------------------------------------------------------
CORE = ["takeOffMTOW", "cruiseTAS", "cruiseCeiling", "takeOffDistance", "landingDistance", "initialClimbROC"]

def srcs_of(o): return o.get("src", [])

def build_type(code, t):
    kind, n = t["kind"], t["n"]
    press = t.get("press", False) or kind == "jet"
    perf, notes = {}, list(t.get("notes", []))
    def put(key, val): perf[key] = val

    # engine
    eng = {"count": n, "kind": kind, "fuel": t["fuel"], "turbocharged": bool(t.get("turbo")), "diesel": bool(t.get("diesel")),
           "pressurized": press}
    if kind == "jet": eng["thrustKN"] = obj(t["eng"], "kN")
    else: eng["hp"] = obj(t["eng"])
    # wingspan
    if "span" in t: span = obj(t["span"], "span")
    else:
        v, m = t["span_est"]; span = {"v": v, "s": "est", "method": m}

    mtow = obj(t["mtow"], "kg"); put("takeOffMTOW", mtow)
    mtow_kg = mtow["v"]
    put("cruiseCeiling", obj(t["ceil"], "hft"))
    ceil_ft = t["ceil"][1]

    # cruise speed / Mach
    alt_ft = (t.get("cruise") or {}).get("alt_ft")
    if "tas" in t: tas = obj(t["tas"])
    elif "tas_est" in t:
        v, m = t["tas_est"]; tas = {"v": v, "s": "est", "method": m}
    else: tas = None   # jets given as cruise Mach: TAS derived below
    if kind == "jet":
        if "mach" in t or "mach_est" in t:
            mo = obj(t["mach"]) if "mach" in t else {"v": t["mach_est"][0], "s": "est", "method": t["mach_est"][1]}
            put("cruiseMACH", mo)
            tas = der(round(mo["v"] * A_TROP), srcs_of(mo), "TAS")
            if mo["s"] == "est": tas = {"v": tas["v"], "s": "est", "method": "[TAS] from the estimated cruise Mach"}
        else:
            a = A_TROP if not alt_ft or alt_ft >= 36089 else 661.47 * (1 - 6.8756e-6 * alt_ft) ** 0.5
            put("cruiseMACH", der(round(tas["v"] / a, 3), srcs_of(tas), "MACH", f"at {alt_ft:,} ft ISA" if alt_ft and alt_ft < 36089 else ""))
    put("cruiseTAS", tas)
    tas_v = tas["v"]

    # range
    if "rng" in t: put("cruiseRange", obj(t["rng"]))
    else: put("cruiseRange", est(r10(4.5 * tas_v), "RANGE"))

    # distances
    def dist(key, gr_key, est_key, rule, factor):
        if key in t: put(key_map[key], obj(t[key], "m")); return
        if gr_key in t:
            g = t[gr_key]; gm = conv(g[1], g[2], "m")
            put(key_map[key], der(round(gm * factor), g[3], rule, f"ground roll {g[1]:,} {g[2]} × {factor}")); return
        if est_key in t:
            v, m = t[est_key]; put(key_map[key], {"v": round(v * FT), "s": "est", "method": m + f" [{v:,} ft]"}); return
        raise ValueError(f"{code}: no {key}")
    key_map = {"to": "takeOffDistance", "ldg": "landingDistance"}
    tp = kind == "turboprop"
    dist("to", "to_gr", "to_est", "TOGR", 1.4 if tp else 1.7)
    dist("ldg", "ldg_gr", "ldg_est", "LDGGR", 1.8 if tp else 2.3)

    # stall / reference speeds
    vso = None
    if "vso" in t: vso_o = obj(t["vso"]); vso = vso_o["v"]
    elif "vso_est" in t: vso = t["vso_est"][0]; vso_o = {"v": vso, "s": "est", "method": t["vso_est"][1]}
    else: vso_o = None

    def from_vso(factor, rule, rnd=round):
        v = rnd(factor * vso)
        if vso_o["s"] == "est": return {"v": v, "s": "est", "method": f"[{rule}] with estimated Vso {vso} kt ({vso_o['method']})"}
        return der(v, vso_o["src"], rule, f"Vso {vso} kt")

    # climb
    if "roc" in t: roc = obj(t["roc"])
    elif "roc_est" in t: roc = {"v": t["roc_est"][0], "s": "est", "method": t["roc_est"][1]}
    else: roc = None
    if kind == "jet":
        thr_lbf = t["eng"][1] if t["eng"][2] == "lbf" else t["eng"][1] / LBF
        if roc is None:
            tw = n * thr_lbf / (mtow_kg / LB)
            roc = est(r100(10600 * tw), "JROC0"); roc["method"] += f" T/W {tw:.3f}"
        put("initialClimbIAS", est(200, "JCLIMB"))
        put("initialClimbROC", roc)
        r0 = roc["v"]
        put("climb150IAS", est(250, "JCLIMB")); put("climb150ROC", est(r100(0.8 * r0), "JROC"))
        put("climb240IAS", est(250, "JCLIMB")); put("climb240ROC", est(r100(0.5 * r0), "JROC"))
        cm = perf["cruiseMACH"]["v"]
        put("machClimbMACH", est(round(max(0.60, cm - 0.05), 2), "JCLIMB"))
        put("machClimbROC", est(r100(0.25 * r0), "JROC"))
    else:
        if roc is None: raise ValueError(f"{code}: no climb rate")
        put("initialClimbROC", roc)
        if "vy" in t: put("initialClimbIAS", obj(t["vy"]))
        else: put("initialClimbIAS", from_vso(1.55, "VY", r5))
        if kind == "turboprop":
            ias0 = perf["initialClimbIAS"]["v"]
            put("climb150IAS", est(r5(1.3 * ias0), "TPCLIMB")); put("climb150ROC", est(r100(0.85 * roc["v"]), "TPCLIMB"))
            if press and ceil_ft > 24000:
                put("climb240IAS", est(r5(1.3 * ias0), "TPCLIMB")); put("climb240ROC", est(r100(0.65 * roc["v"]), "TPCLIMB"))

    # descent / approach / landing speeds
    if kind == "jet":
        put("initialDescentMACH", est(perf["cruiseMACH"]["v"], "JDES"))
        put("initialDescentROD", est(2500, "JDES"))
        put("descentIAS", est(250 if mtow_kg <= 7000 else 280, "DESIASJ"))
        put("descentROD", est(2500, "DESROD"))
        if "vref" in t: vat = obj(t["vref"])
        else: vat = est(t["vref_est"], "VREFJ")
        put("landingVat", vat)
        put("approachIAS", est(r5(vat["v"] + 40), "APPJ"))
        put("takeOffV2", est(vat["v"] + 5, "V2J"))
    else:
        alt_k = (alt_ft or (8000 if kind == "piston" else 20000)) / 1000
        d = est(r5(max(tas_v / (1 + 0.02 * alt_k), 0.75 * tas_v)), "DESIAS")
        if not alt_ft: d["method"] += f" cruise altitude not stated, {int(alt_k*1000):,} ft assumed"
        put("descentIAS", d)
        rod = 500 if kind == "piston" and not press else 1000 if (kind == "piston" or not press) else 1500
        put("descentROD", est(rod, "DESROD"))
        put("landingVat", obj(t["vat"]) if "vat" in t else from_vso(1.3, "VAT"))
        put("approachIAS", obj(t["app"]) if "app" in t else from_vso(1.5, "APP", r5))
        put("takeOffV2", obj(t["v50"]) if "v50" in t else from_vso(1.2, "V50"))
    put("approachROD", est(r50(5.3 * perf["approachIAS"]["v"]), "APPROD"))

    # fuel
    fuel = {}
    if "ff" in t:
        st, v, u, src, ref = t["ff"]
        kgh = v * (AVGAS_KG_GAL if t["fuel"] == "avgas" else JET_KG_GAL) if u == "gph" else v * JET_KG_L if u == "lph" else v * LB
        fuel["cruise"] = {"kgh": {"v": round(kgh, 1), "s": st, "src": src if isinstance(src, list) else [src], "ref": ref + f" [{v} {u}]"},
                          **{k: v2 for k, v2 in t.get("ff_meta", {}).items()}, "engines": "total" if n > 1 else "single"}

    # metadata
    ek = {"piston": "P", "turboprop": "T", "jet": "J"}[kind]
    rec = {
        "name": t["name"], "variant": t["variant"],
        "type": {"v": f"L{n}{ek}", "s": "der", "src": srcs_of(eng.get("hp") or eng.get("thrustKN")), "method": "[DESIG]"},
        "wtc": {"v": "L" if mtow_kg <= 7000 else "M", "s": "der", "src": srcs_of(mtow), "method": "[WTC]"},
        "engine": eng, "wingspan_m": span,
        "cruise": {"power": (t.get("cruise") or {}).get("power", "maximum/high-speed cruise" if kind == "jet" else None), "alt_ft": alt_ft},
        "perf": dict(sorted(perf.items())),
    }
    if fuel: rec["fuel"] = fuel
    rec["sourcing"], why = grade(rec)
    if why: rec["sourcing_reasons"] = why
    if notes: rec["notes"] = notes
    return rec

def grade(rec):
    """good: all core values pub from manufacturer/POH; weak: any core value estimated, aggregator-only,
    or more than two recalled; fair otherwise. Returns (grade, reasons)."""
    core = [k for k in CORE if not (k == "initialClimbROC" and rec["engine"]["kind"] == "jet")]
    vals = [(k, rec["perf"][k]) for k in core] + [("engine power", rec["engine"].get("hp") or rec["engine"].get("thrustKN"))]
    reasons, rec_n, all_primary = [], 0, True
    for k, o in vals:
        if o["s"] == "est": reasons.append(f"{k} estimated"); all_primary = False; continue
        if o["s"] == "rec": rec_n += 1; all_primary = False
        ks = {SOURCES[s]["kind"] for s in o.get("src", [])}
        if ks and ks <= {"aggregator"}: reasons.append(f"{k} from aggregator only")
        if not ks & {"manufacturer", "poh"}: all_primary = False
    if rec_n > 2: reasons.append(f"{rec_n} core values recalled, not re-checked")
    if reasons: return "weak", reasons
    return ("good" if all_primary else "fair"), []

SCHEMA = {
 "about": "XPerf's own performance table for the 82 GA / turboprop / business-jet types previously read from EUROCONTROL. Built from independent public sources only (manufacturer pages and brochures, POH/AFM figures, magazine standard-data pages, compiled reference pages); EUROCONTROL data was used only as a private sanity check and is not copied here. For flight simulation only — not for real-world flight planning.",
 "generated_by": "tools/build_ga_perf.py (edit there, then regenerate); validate with tools/validate_ga_perf.py",
 "checked_on": CHECKED,
 "value_object": {"v": "the value, in the unit listed under perf_fields", "s": "status: pub | rec | der | est",
                  "src": "list of source ids (see sources)", "ref": "what the source says, in its own units/conditions",
                  "method": "for der/est: how the value was derived or estimated (rule ids in [brackets], see rules)"},
 "status": {"pub": "published figure, read online from the cited source on checked_on (directly or via a search engine's summary of that page)",
            "rec": "published figure attributed to the cited document, from recall, NOT re-read online — verify before release",
            "der": "derived arithmetically from sourced values", "est": "estimate — method stated, no source"},
 "perf_fields": {
   "takeOffMTOW": "kg — maximum take-off weight",
   "takeOffDistance": "m — pistons/turboprops: total distance to 50 ft (15 m) at MTOW, SL, ISA, paved dry; jets: take-off field length (FAR/CS-25) at MTOW, SL, ISA. Note: EUROCONTROL's value for GA types is closer to a ground roll, so runway checks get more conservative",
   "takeOffV2": "kt IAS — pistons/turboprops: speed at 50 ft; jets: V2",
   "initialClimbIAS": "kt IAS — climb speed below 5,000 ft (Vy for pistons)", "initialClimbROC": "fpm — sea-level climb rate at MTOW",
   "climb150IAS": "kt IAS — climb speed 5,000 ft–FL150 (turboprops, jets)", "climb150ROC": "fpm",
   "climb240IAS": "kt IAS — climb speed FL150–FL240 (pressurized turboprops, jets)", "climb240ROC": "fpm",
   "machClimbMACH": "Mach — climb above FL240 (jets)", "machClimbROC": "fpm",
   "cruiseTAS": "kt TAS at the power/altitude in the type's cruise block (not necessarily 65%)",
   "cruiseMACH": "Mach (jets)", "cruiseCeiling": "hundreds of ft — service ceiling (pistons) or maximum operating/certified altitude (turboprops, jets)",
   "cruiseRange": "NM — published maximum range (conditions in ref)",
   "initialDescentMACH": "Mach (jets)", "initialDescentROD": "fpm (jets)",
   "descentIAS": "kt IAS", "descentROD": "fpm", "approachIAS": "kt IAS — speed flown in the last 1,500/2,000/3,000 ft AGL (piston/turboprop/jet)",
   "approachROD": "fpm", "landingVat": "kt IAS — threshold / approach speed at 50 ft (Vref)",
   "landingDistance": "m — pistons/turboprops: total distance from 50 ft at max landing weight, SL, ISA; jets: unfactored landing distance (conditions in ref)"},
 "other_fields": {
   "type": "ICAO type description (L<engines><P|T|J>)", "wtc": "ICAO wake category from MTOW",
   "engine": "count, kind, fuel (avgas | jet-a), turbocharged, diesel, pressurized, and per-engine power: hp (shaft/brake hp) or thrustKN — replaces EUROCONTROL power-plant text parsing and ENGINE_FIX",
   "wingspan_m": "m — used by the jet drag polar",
   "cruise": "power setting and altitude that cruiseTAS refers to (null = not stated by the source)",
   "fuel.cruise": "published cruise fuel flow: kgh (kg/h, total for all engines), with setting / alt_ft / tas_kt; avgas 2.72 kg/US gal, Jet A 3.04 kg/US gal or 0.803 kg/L",
   "sourcing_reasons": "why a type is graded weak",
   "sourcing": "good: all core values (MTOW, cruise TAS, ceiling, TO/LDG distance, climb rate, engine power) published by the manufacturer or in the POH and checked online; fair: core values sourced but partly secondary or recalled; weak: some core value estimated, aggregator-only, or more than two recalled"},
 "rules": RULES,
}

def main():
    out = {"_schema": SCHEMA, "sources": SOURCES, "types": {c: build_type(c, TYPES[c]) for c in sorted(TYPES)}}
    used = {s for rec in out["types"].values() for s in _walk_src(rec)}
    unknown = used - set(SOURCES)
    if unknown: raise SystemExit(f"unknown source ids: {sorted(unknown)}")
    out["sources"] = {k: v for k, v in SOURCES.items() if k in used}
    path = os.path.join(os.path.dirname(__file__), "..", "data", "ga_perf.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote {os.path.normpath(path)}: {len(out['types'])} types, {len(out['sources'])} sources")

def _walk_src(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "src": yield from v
            else: yield from _walk_src(v)
    elif isinstance(o, list):
        for v in o: yield from _walk_src(v)

if __name__ == "__main__":
    main()
