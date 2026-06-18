import { useCallback, useRef, useState } from 'react'
import JSZip from 'jszip'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import shapeShifterLogo from '../assets/ShapeShifter_Logo.jpg'
import {
  isDriveConfigured,
  getConnection,
  connectDrive,
  disconnectDrive,
} from '../lib/googleDrivePicker'
import {
  Scissors,
  UploadCloud,
  FileArchive,
  X,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  RefreshCw,
  FileSpreadsheet,
  Files,
  FileWarning,
  FileDown,
  HardDrive,
  Info,
  ListChecks,
  XCircle,
} from 'lucide-react'

/**
 * ThreadValidate CAD
 * A self-contained, interactive CAD (.zip) validation landing page for garment
 * manufacturers. The archive is expected to contain one .xlsx specification file
 * and many .tmp Gerber CAD files.
 *
 * What is REAL here:
 *   - The uploaded .zip is actually parsed (JSZip) and its real entry names read.
 *   - Structural checks are real: a missing .xlsx or missing .tmp is detected
 *     from the true archive contents and reported.
 *
 * What is SIMULATED (placeholder for the future deep validation engine):
 *   - The per-file pass/fail of each .tmp Gerber file. The Pass/Fail demo toggle
 *     drives the outcome, but the FAILED FILE NAMES shown are the real names
 *     pulled from the uploaded archive.
 */

// Plausible Gerber-file failure reasons, each paired with a suggested fix.
// (Both are placeholders until the real deep-validation engine lands.)
const TMP_ISSUES = [
  {
    reason: 'Contour not closed — piece boundary is open',
    fix: 'Close the outer contour so the piece forms a single sealed polyline, then re-export.',
  },
  {
    reason: 'Missing grain line reference',
    fix: 'Add a grain line to the piece and re-export with the grain reference enabled.',
  },
  {
    reason: 'Unrecognized Gerber block header',
    fix: 'Re-export from the source pattern using a supported Gerber / AAMA-DXF profile.',
  },
  {
    reason: 'Seam allowance not defined on outer edge',
    fix: 'Define seam allowance on all outer edges before exporting the piece.',
  },
  {
    reason: 'Notch table is empty',
    fix: 'Add the required notches and confirm the notch table is populated on export.',
  },
  {
    reason: 'Piece scale mismatch vs. spreadsheet',
    fix: 'Verify the piece units/scale match the spec sheet (cm vs. inch) and re-grade.',
  },
  {
    reason: 'Internal cut line crosses piece boundary',
    fix: 'Adjust internal cut lines so they remain inside the piece boundary.',
  },
  {
    reason: 'Grade rule index out of range',
    fix: 'Map the piece to a valid grade-rule index in your grading table.',
  },
  {
    reason: 'Mirrored piece flag conflicts with style',
    fix: 'Correct the mirror / asymmetry flag so it matches the style definition.',
  },
  {
    reason: 'Drill / punch marker outside cut zone',
    fix: 'Move drill / punch markers inside the cut zone before exporting.',
  },
]

// Realistic garment styles used to generate demo packages.
const GARMENT_STYLES = [
  {
    code: 'BLZ-2041',
    name: 'Tailored Blazer',
    pieces: ['Front_Panel', 'Back_Panel', 'Side_Panel', 'Sleeve_Upper', 'Sleeve_Under', 'Collar', 'Lapel', 'Pocket_Welt'],
  },
  {
    code: 'TSH-1180',
    name: 'Crew Neck Tee',
    pieces: ['Front_Body', 'Back_Body', 'Sleeve_L', 'Sleeve_R', 'Neck_Rib'],
  },
  {
    code: 'CGP-3302',
    name: 'Cargo Pant',
    pieces: ['Front_Leg', 'Back_Leg', 'Waistband', 'Cargo_Pocket', 'Fly_Shield', 'Belt_Loop', 'Hem_Cuff'],
  },
  {
    code: 'HOD-2270',
    name: 'Pullover Hoodie',
    pieces: ['Front_Body', 'Back_Body', 'Hood_Side', 'Hood_Center', 'Sleeve_L', 'Sleeve_R', 'Kanga_Pocket', 'Cuff', 'Hem_Band'],
  },
]

const SIZE_BREAK = 'M' // graded base size, just for realistic file names

// Maximum number of cut plans a user is allowed to upload / validate.
const MAX_CUTPLANS = 5

// Persisted log of every cut plan that has been validated, with its pass/fail
// verdict (and, on failure, the reason), kept across reloads so both the header
// status bar and the side status panel reflect real progress.
const CUTPLANS_KEY = 'tvc.cutplans'
function readCutplans() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUTPLANS_KEY) || '[]')
    return Array.isArray(arr) ? arr.slice(0, MAX_CUTPLANS) : []
  } catch {
    return []
  }
}
function saveCutplans(list) {
  try {
    localStorage.setItem(CUTPLANS_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable — keep the in-memory list */
  }
}

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
const pick = (arr) => arr[randInt(0, arr.length - 1)]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Random distinct indices, count of them, from [0, length).
function sampleIndices(length, count) {
  const pool = Array.from({ length }, (_, i) => i)
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = randInt(0, i)
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count).sort((a, b) => a - b)
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

const isZip = (file) =>
  !!file &&
  (file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    /\.zip$/i.test(file.name))

// Read the archive and bucket its entries by type. Real parse, real names.
async function inspectArchive(file) {
  let zip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    return { corrupt: true }
  }
  const baseNames = Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => f.name.split('/').pop())
    .filter(Boolean)

  return {
    corrupt: false,
    xlsxNames: baseNames.filter((n) => /\.xlsx$/i.test(n)),
    tmpNames: baseNames.filter((n) => /\.tmp$/i.test(n)),
    otherNames: baseNames.filter((n) => !/\.(xlsx|tmp)$/i.test(n)),
  }
}

// Placeholder for the real Gerber engine: fail a random 1–3 of the files in
// Fail mode, each with a distinct realistic reason + suggested fix.
function simulateTmpFailures(tmpNames, outcome) {
  if (outcome === 'pass' || tmpNames.length === 0) return []
  const failCount = Math.min(tmpNames.length, randInt(1, 3))
  const issues = [...TMP_ISSUES]
  return sampleIndices(tmpNames.length, failCount).map((idx) => {
    const issue = issues.splice(randInt(0, issues.length - 1), 1)[0]
    return { name: tmpNames[idx], reason: issue.reason, fix: issue.fix }
  })
}

// ----- PDF failure report -----
const LOGO_RATIO = 4.982 // ShapeShifter wordmark width / height

// Fetch the bundled logo once and cache it as a data URL for jsPDF.
let _logoDataUrl = null
async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl
  try {
    const blob = await (await fetch(shapeShifterLogo)).blob()
    _logoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    _logoDataUrl = null
  }
  return _logoDataUrl
}

function makeReportId() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `TVC-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function downloadFailureReport(file, result) {
  const { info, failedTmps = [], structural = [], kind } = result
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 40
  const reportId = makeReportId()
  const logo = await getLogoDataUrl()

  // Header band
  doc.setFillColor(15, 23, 42)
  doc.rect(0, 0, pageW, 78, 'F')

  // ShapeShifter logo on a white chip (the wordmark is dark, so it needs a light backing)
  const logoH = 18
  const logoW = logoH * LOGO_RATIO
  const pad = 9
  doc.setFillColor(255, 255, 255)
  doc.roundedRect(margin, 22, logoW + pad * 2, logoH + pad, 6, 6, 'F')
  if (logo) doc.addImage(logo, 'JPEG', margin + pad, 22 + pad / 2, logoW, logoH)

  // Product lockup to the right of the logo
  const tx = margin + logoW + pad * 2 + 16
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('ThreadValidate CAD', tx, 40)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9.5)
  doc.setTextColor(203, 213, 225)
  doc.text('CAD Package Validation Report', tx, 55)

  // Verdict
  let y = 104
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(220, 38, 38)
  doc.text('VALIDATION FAILED', margin, y)

  // Meta
  y += 24
  doc.setFontSize(10)
  doc.setTextColor(51, 65, 85)
  const meta = [
    ['Package', file?.name || '—'],
    ['Report ID', reportId],
    ['Generated', new Date().toLocaleString()],
    [
      'Contents',
      `${info?.xlsxNames.length ?? 0} spreadsheet (.xlsx) · ${info?.tmpNames.length ?? 0} Gerber (.tmp)`,
    ],
  ]
  meta.forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold')
    doc.text(`${k}:`, margin, y)
    doc.setFont('helvetica', 'normal')
    doc.text(String(v), margin + 72, y)
    y += 16
  })
  y += 8

  const tableTheme = {
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: 6, valign: 'top', textColor: [30, 41, 59] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: margin, right: margin },
  }

  if (kind === 'structure') {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(220, 38, 38)
    doc.text(`${structural.length} structural issue(s) detected`, margin, y)
    autoTable(doc, {
      ...tableTheme,
      startY: y + 10,
      head: [['#', 'Issue', 'Detail']],
      body: structural.map((s, i) => [i + 1, s.title, s.detail]),
      columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 170 } },
    })
  } else {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(220, 38, 38)
    doc.text(
      `${failedTmps.length} of ${info.tmpNames.length} Gerber (.tmp) files failed validation`,
      margin,
      y,
    )
    autoTable(doc, {
      ...tableTheme,
      startY: y + 10,
      head: [['#', 'File Name', 'Root Cause', 'Suggested Fix']],
      body: failedTmps.map((f, i) => [i + 1, f.name, f.reason, f.fix || '—']),
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 150, font: 'courier', fontSize: 8 },
        2: { cellWidth: 150 },
      },
    })
    const passed = info.tmpNames.length - failedTmps.length
    if (passed > 0) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(10)
      doc.setTextColor(22, 163, 74)
      doc.text(`${passed} Gerber file(s) passed validation.`, margin, doc.lastAutoTable.finalY + 20)
    }
  }

  // Footer
  doc.setDrawColor(226, 232, 240)
  doc.line(margin, pageH - 52, pageW - margin, pageH - 52)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(148, 163, 184)
  doc.text(`© ${new Date().getFullYear()} ShapeShifter. All rights reserved.`, margin, pageH - 36)
  doc.text('Generated by ThreadValidate CAD', pageW - margin, pageH - 36, { align: 'right' })
  doc.text(
    'Structural checks are authoritative; per-file Gerber findings are indicative pending deep validation.',
    margin,
    pageH - 24,
  )

  // Report name mirrors the uploaded zip's name (just the .pdf extension).
  const base = (file?.name || 'package').replace(/\.zip$/i, '')
  doc.save(`${base}.pdf`)
}

// Build a realistic in-memory package zip for a given style (shared by the demo
// samples and the simulated Google Drive picker).
async function buildPackageZip(style, kind = 'valid') {
  const zip = new JSZip()
  if (kind !== 'no-xlsx') {
    zip.file(`${style.code}_BOM_SS25.xlsx`, new Uint8Array(randInt(20, 70) * 1024))
  }
  if (kind !== 'no-tmp') {
    const count = randInt(Math.min(4, style.pieces.length), style.pieces.length)
    sampleIndices(style.pieces.length, count).forEach((i) => {
      zip.file(
        `${style.code}_${style.pieces[i]}_${SIZE_BREAK}_GRADED.tmp`,
        new Uint8Array(randInt(60, 280) * 1024),
      )
    })
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
  const suffix = kind === 'no-xlsx' ? '_NoSpec' : kind === 'no-tmp' ? '_NoGerber' : ''
  return new File([blob], `${style.code}_${style.name.replace(/\s+/g, '')}_Marker${suffix}.zip`, {
    type: 'application/zip',
  })
}

// The files the simulated Google Drive shows (one valid package per style).
const DRIVE_FILES = GARMENT_STYLES.map((style) => ({
  style,
  name: `${style.code}_${style.name.replace(/\s+/g, '')}_Marker.zip`,
}))

export default function CadValidator() {
  const [file, setFile] = useState(null)
  // status: 'idle' | 'selected' | 'validating' | 'error' | 'success'
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [hint, setHint] = useState('')
  const [outcome, setOutcome] = useState('fail') // demo toggle: 'fail' | 'pass'
  // Persistent log of validated cut plans (name + pass/fail verdict + reason).
  const [cutplans, setCutplans] = useState(readCutplans)
  const passedCount = cutplans.filter((c) => c.status === 'pass').length
  const [driveLoading, setDriveLoading] = useState(false)
  const [drivePickerOpen, setDrivePickerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const driveConfigured = isDriveConfigured()
  // Seed from localStorage so a returning user shows as already connected.
  const [drive, setDrive] = useState(() =>
    driveConfigured ? getConnection() : { connected: false, email: null },
  )

  const inputRef = useRef(null)

  const reset = useCallback(() => {
    setFile(null)
    setStatus('idle')
    setResult(null)
    setHint('')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  // Append a validated cut plan to the log and persist it.
  const recordCutplan = useCallback((entry) => {
    setCutplans((prev) => {
      const next = [...prev, entry].slice(0, MAX_CUTPLANS)
      saveCutplans(next)
      return next
    })
  }, [])

  // Clear the cut-plan log so the user can start a fresh batch of 5.
  const clearCutplans = useCallback(() => {
    setCutplans([])
    saveCutplans([])
  }, [])

  const acceptFile = useCallback((incoming) => {
    if (!incoming) return
    if (cutplans.length >= MAX_CUTPLANS) {
      setHint(`You can upload a maximum of ${MAX_CUTPLANS} cut plans. Clear the list to start a new batch.`)
      return
    }
    if (!isZip(incoming)) {
      setHint('Only .zip archives are supported. Please export your CAD package as a .zip.')
      return
    }
    setHint('')
    setResult(null)
    setFile(incoming)
    setStatus('selected')
  }, [cutplans.length])

  // ----- Drag & drop -----
  const onDragOver = (e) => {
    e.preventDefault()
    if (status === 'validating') return
    setIsDragging(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault()
    setIsDragging(false)
  }
  const onDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (status === 'validating') return
    acceptFile(e.dataTransfer.files?.[0])
  }
  const onBrowse = (e) => acceptFile(e.target.files?.[0])
  const openPicker = () => {
    if (status === 'validating') return
    inputRef.current?.click()
  }

  // Connect: opens Google's own login/consent popup, then remembers the session.
  const connect = async () => {
    if (driveLoading) return
    setHint('')
    setDriveLoading(true)
    try {
      const { email } = await connectDrive()
      setDrive({ connected: true, email })
    } catch {
      setHint('Could not connect to Google Drive. Please try again.')
    } finally {
      setDriveLoading(false)
    }
  }

  const disconnect = () => {
    disconnectDrive()
    setDrive({ connected: false, email: null })
  }

  // Open the simulated Drive file browser.
  const openDrivePicker = () => {
    if (status === 'validating' || driveLoading) return
    setHint('')
    setDrivePickerOpen(true)
  }

  // Pick a file from the simulated Drive: build that package in-memory, then validate.
  const pickFromDrive = async (entry) => {
    setDrivePickerOpen(false)
    setDriveLoading(true)
    try {
      acceptFile(await buildPackageZip(entry.style, 'valid'))
    } finally {
      setDriveLoading(false)
    }
  }

  // ----- Validation -----
  const validate = async () => {
    if (!file || status === 'validating') return
    setStatus('validating')
    const [info] = await Promise.all([inspectArchive(file), delay(randInt(900, 1700))])

    if (info.corrupt) {
      setResult({ kind: 'corrupt' })
      setStatus('error')
      recordCutplan({
        name: file.name,
        status: 'fail',
        reason: 'Archive could not be read — it may be corrupt or not a valid .zip file.',
      })
      return
    }

    // Real structural checks.
    const structural = []
    if (info.xlsxNames.length === 0)
      structural.push({
        icon: FileSpreadsheet,
        title: 'Missing spreadsheet (.xlsx)',
        detail: 'The archive must contain one .xlsx specification file — none was found.',
      })
    if (info.tmpNames.length === 0)
      structural.push({
        icon: Files,
        title: 'Missing Gerber CAD files (.tmp)',
        detail: 'The archive must contain at least one .tmp Gerber file — none was found.',
      })

    if (structural.length) {
      setResult({ kind: 'structure', structural, info })
      setStatus('error')
      recordCutplan({
        name: file.name,
        status: 'fail',
        reason: structural.map((s) => s.title).join('; '),
      })
      return
    }

    // Simulated per-file Gerber validation (real names, placeholder verdicts).
    const failedTmps = simulateTmpFailures(info.tmpNames, outcome)
    if (failedTmps.length) {
      setResult({ kind: 'tmp', failedTmps, info })
      setStatus('error')
      recordCutplan({
        name: file.name,
        status: 'fail',
        reason:
          `${failedTmps.length} of ${info.tmpNames.length} Gerber (.tmp) file(s) failed — ` +
          failedTmps.map((f) => `${f.name}: ${f.reason}`).join('; '),
      })
    } else {
      setResult({ kind: 'success', info })
      setStatus('success')
      // A cut plan only counts as passed once it has truly cleared validation.
      recordCutplan({ name: file.name, status: 'pass' })
    }
  }

  const canValidate = status === 'selected'
  const showZone = status === 'idle' || status === 'validating'
  const info = result?.info

  return (
    <div className="pattern-bg min-h-screen w-full">
      <div className="weave-overlay min-h-screen w-full">
        <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center px-5 py-10 sm:py-12">
          {/* ---------- Brand bar ---------- */}
          <div className="mb-8 flex w-full items-center gap-4">
            {/* Left: ShapeShifter brand logo */}
            <div className="flex flex-1 items-center justify-start">
              <span className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 shadow-md ring-1 ring-black/5">
                <img src={shapeShifterLogo} alt="ShapeShifter" className="h-5 w-auto" />
              </span>
            </div>
            {/* Center: product lockup */}
            <div className="flex items-center justify-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500 text-slate-950 shadow-lg shadow-brand-500/20 ring-1 ring-brand-300/40">
                <Scissors className="h-5 w-5" strokeWidth={2.4} />
              </span>
              <div className="text-left">
                <h1 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">
                  ThreadValidate <span className="text-brand-400">CAD</span>
                </h1>
                <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
                  Pattern &amp; Marker Integrity Suite
                </p>
              </div>
            </div>
            {/* Right: status bar + info */}
            <div className="flex flex-1 items-center justify-end gap-2">
              {/* Persistent readiness status bar — counts cut plans that have
                  PASSED validation, so it reflects genuine readiness to submit. */}
              <span
                aria-live="polite"
                title="Cut plans that have passed validation and are ready to submit"
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  passedCount > 0
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-900/60 text-slate-400'
                }`}
              >
                <CheckCircle2
                  className={`h-3.5 w-3.5 ${passedCount > 0 ? 'text-emerald-400' : 'text-slate-500'}`}
                />
                {passedCount > 0 ? (
                  <>
                    <span className="text-emerald-200">{passedCount}</span> cut plan
                    {passedCount > 1 ? 's' : ''} validated · ready to submit
                  </>
                ) : (
                  'No cut plans validated yet'
                )}
              </span>
              {/* Single, unobtrusive help affordance — purpose + how-to on demand. */}
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                aria-label="About this portal and how to use it"
                title="What is this? How do I use it?"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-700 bg-slate-900/60 text-slate-400 transition hover:border-brand-400/60 hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* ---------- Header / Hero ---------- */}
          <header className="mb-8 flex w-full flex-col items-center text-center">
            <p className="max-w-2xl text-balance text-lg font-semibold text-white sm:text-xl">
              Welcome to ThreadValidate CAD 👋
            </p>
            <p className="mt-2 max-w-2xl text-balance text-base leading-relaxed text-slate-300 sm:text-lg">
              Validate apparel CAD packages before they reach the cutting floor.
              Upload a <span className="font-mono text-brand-300">.zip</span> containing your{' '}
              <span className="font-mono text-brand-300">Cut Plan(xlxs/pdf)</span>  and{' '}
              <span className="font-mono text-brand-300">CAD Files</span>.
            </p>
            <span className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-200">
              <Info className="h-4 w-4" />
              You are allowed to upload a maximum of {MAX_CUTPLANS} cut plans
            </span>
          </header>

          {/* ---------- Card + status panel ---------- */}
          <div className="flex w-full flex-col gap-6 lg:flex-row lg:items-start">
          <section className="min-w-0 flex-1 rounded-2xl border border-slate-700/60 bg-slate-900/70 p-5 shadow-2xl shadow-black/40 backdrop-blur-sm sm:p-7">
            {/* Demo controls */}
            <div className="mb-5 rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-slate-400">
                  <ShieldCheck className="h-4 w-4 text-brand-400" />
                  Demo mode — simulate Gerber result
                </span>
                <div className="flex rounded-md bg-slate-800 p-0.5 text-sm font-semibold">
                  <button
                    type="button"
                    onClick={() => setOutcome('fail')}
                    className={`rounded px-3 py-1 transition ${
                      outcome === 'fail' ? 'bg-red-500/90 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Fail
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutcome('pass')}
                    className={`rounded px-3 py-1 transition ${
                      outcome === 'pass' ? 'bg-emerald-500/90 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Pass
                  </button>
                </div>
              </div>
            </div>

            {/* ---------- Drop zone ---------- */}
            {showZone && (
              <>
              <button
                type="button"
                onClick={openPicker}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                disabled={status === 'validating'}
                className={`group relative flex min-h-[380px] w-full flex-col items-center justify-center gap-5 rounded-xl border-2 border-dashed px-6 py-20 text-center transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 sm:py-28 ${
                  isDragging
                    ? 'brand-glow scale-[1.01] border-brand-400 bg-brand-500/10'
                    : 'border-slate-600 bg-slate-950/30 hover:border-brand-400/70 hover:bg-slate-950/50'
                }`}
              >
                <span
                  className={`grid h-20 w-20 place-items-center rounded-full transition-all duration-200 ${
                    isDragging ? 'bg-brand-500 text-slate-950' : 'bg-slate-800 text-brand-400 group-hover:bg-slate-700'
                  }`}
                >
                  <UploadCloud className="h-10 w-10" strokeWidth={2} />
                </span>
                <span className="space-y-1.5">
                  <span className="block text-xl font-semibold text-white">
                    {isDragging ? 'Release to upload' : 'Drag & drop your .zip here'}
                  </span>
                  <span className="block text-base text-slate-400">
                    or{' '}
                    <span className="font-medium text-brand-300 underline-offset-2 group-hover:underline">
                      click to browse
                    </span>{' '}
                    your files
                  </span>
                </span>
                <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/70 px-3.5 py-1.5 text-xs font-medium text-slate-400">
                  <FileArchive className="h-4 w-4" /> Expects 1 × .xlsx and one or more CAD files in the zip
                </span>
              </button>

              {driveConfigured && (
                <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  {!drive.connected ? (
                    <button
                      type="button"
                      onClick={connect}
                      disabled={driveLoading}
                      className="flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-wait disabled:opacity-70"
                    >
                      {driveLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Connecting to Google Drive…
                        </>
                      ) : (
                        <>
                          <HardDrive className="h-4 w-4 text-brand-400" /> Connect Google Drive
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 text-xs text-slate-300">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        <span className="shrink-0">Google Drive ·</span>
                        <span className="truncate text-slate-400" title={drive.email || 'Connected'}>
                          {drive.email || 'Connected'}
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={openDrivePicker}
                          disabled={status === 'validating' || driveLoading}
                          className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-wait disabled:opacity-70"
                        >
                          {driveLoading ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…
                            </>
                          ) : (
                            <>
                              <HardDrive className="h-3.5 w-3.5" /> Pick file from Drive
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={disconnect}
                          className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 transition hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              </>
            )}

            {/* Selected file card */}
            {status === 'selected' && file && (
              <div className="animate-scale-in rounded-xl border border-slate-700 bg-slate-950/40 p-4 sm:p-5">
                <div className="flex items-center gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/30">
                    <FileArchive className="h-6 w-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-white" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-xs text-slate-400">{formatBytes(file.size)} · ready to validate</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={openPicker}
                      title="Replace file"
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Replace
                    </button>
                    <button
                      type="button"
                      onClick={reset}
                      title="Remove file"
                      className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-red-500/15 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              onChange={onBrowse}
              className="hidden"
            />

            {hint && (
              <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-red-400">
                <AlertTriangle className="h-3.5 w-3.5" /> {hint}
              </p>
            )}

            {/* ---------- Validate button ---------- */}
            {status !== 'success' && (
              <button
                type="button"
                onClick={validate}
                disabled={!canValidate && status !== 'validating'}
                className={`mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                  status === 'validating'
                    ? 'cursor-wait bg-brand-500/80 text-slate-950'
                    : canValidate
                      ? 'bg-brand-500 text-slate-950 shadow-lg shadow-brand-500/25 hover:bg-brand-400 active:scale-[0.99]'
                      : 'cursor-not-allowed bg-slate-800 text-slate-500'
                }`}
              >
                {status === 'validating' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Inspecting archive…
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" /> Validate Files
                  </>
                )}
              </button>
            )}

            {/* ---------- Result: ERROR ---------- */}
            {status === 'error' && result && (
              <div
                role="alert"
                aria-live="assertive"
                className="animate-fade-in-up mt-5 overflow-hidden rounded-xl border border-red-500/40 bg-red-500/10"
              >
                <div className="flex items-start gap-3 border-b border-red-500/20 p-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-red-500/20 text-red-400">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-bold text-red-300">Validation Failed</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-red-100/80">
                      Please correct the internal CAD file structure inside the zip archive and re-upload.
                    </p>
                  </div>
                </div>

                <div className="p-4">
                  {/* Archive contents summary (real, when we could read it) */}
                  {info && (
                    <div className="mb-4 flex flex-wrap gap-2 text-[11px]">
                      <Chip
                        ok={info.xlsxNames.length > 0}
                        label={`${info.xlsxNames.length} spreadsheet (.xlsx)`}
                      />
                      <Chip
                        ok={info.tmpNames.length > 0}
                        label={`${info.tmpNames.length} Gerber (.tmp)`}
                      />
                      {info.otherNames.length > 0 && (
                        <span className="rounded-full border border-slate-600 bg-slate-800/60 px-2.5 py-1 text-slate-400">
                          {info.otherNames.length} other file(s)
                        </span>
                      )}
                    </div>
                  )}

                  {/* Corrupt archive */}
                  {result.kind === 'corrupt' && (
                    <p className="rounded-lg border border-red-500/15 bg-slate-950/40 p-3 text-sm text-slate-200">
                      The archive could not be read — it may be corrupt or not a valid .zip file.
                    </p>
                  )}

                  {/* Structural issues */}
                  {result.kind === 'structure' && (
                    <>
                      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-red-300/70">
                        {result.structural.length} structural issue
                        {result.structural.length > 1 ? 's' : ''} detected
                      </p>
                      <ul className="space-y-2">
                        {result.structural.map((err, i) => {
                          const Icon = err.icon
                          return (
                            <li
                              key={i}
                              className="flex items-start gap-3 rounded-lg border border-red-500/15 bg-slate-950/40 p-3"
                            >
                              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                              <div>
                                <p className="text-sm font-semibold text-slate-100">{err.title}</p>
                                <p className="text-xs text-slate-400">{err.detail}</p>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}

                  {/* Failed .tmp files list */}
                  {result.kind === 'tmp' && (
                    <>
                      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-red-300/70">
                        {result.failedTmps.length} of {info.tmpNames.length} Gerber (.tmp) files failed validation
                      </p>
                      <ul className="space-y-2">
                        {result.failedTmps.map((f) => (
                          <li
                            key={f.name}
                            className="flex items-start gap-3 rounded-lg border border-red-500/15 bg-slate-950/40 p-3"
                          >
                            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                            <div className="min-w-0">
                              <p className="truncate font-mono text-sm font-semibold text-slate-100" title={f.name}>
                                {f.name}
                              </p>
                              <p className="text-xs text-slate-400">{f.reason}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {info.tmpNames.length - result.failedTmps.length > 0 && (
                        <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-400/80">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {info.tmpNames.length - result.failedTmps.length} Gerber file
                          {info.tmpNames.length - result.failedTmps.length > 1 ? 's' : ''} passed
                        </p>
                      )}
                    </>
                  )}

                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={openPicker}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                    >
                      <UploadCloud className="h-4 w-4" /> Re-upload corrected .zip
                    </button>
                    {result.kind !== 'corrupt' && (
                      <button
                        //type="button"
                        //onClick={() => downloadFailureReport(file, result)}
                        //className="flex items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-brand-400/60 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                      >
                        {/* <FileDown className="h-4 w-4" /> Download report (PDF) */}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={reset}
                      className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                    >
                      Start over
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ---------- Result: SUCCESS ---------- */}
            {status === 'success' && info && (
              <div
                role="status"
                aria-live="polite"
                className="animate-fade-in-up mt-5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/20 text-emerald-400">
                    <CheckCircle2 className="h-5 w-5" />
                  </span>
                  <div className="flex-1">
                    <p className="font-bold text-emerald-300">Validation Passed</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-emerald-100/80">
                      {info.xlsxNames.length} spreadsheet and {info.tmpNames.length} Gerber file
                      {info.tmpNames.length > 1 ? 's' : ''} verified — this package is cleared for the
                      cutting floor.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                      <Chip ok label={`${info.xlsxNames.length} spreadsheet (.xlsx)`} />
                      <Chip ok label={`${info.tmpNames.length} Gerber (.tmp)`} />
                    </div>
                    <button
                      type="button"
                      onClick={reset}
                      className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      <UploadCloud className="h-4 w-4" /> Validate another package
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ---------- Cut plan status panel ---------- */}
          <CutplanPanel cutplans={cutplans} limit={MAX_CUTPLANS} onClear={clearCutplans} />
          </div>

          {/* ---------- Footer ---------- */}
          <footer className="mt-8 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-slate-600" /> Files processed securely
              </span>
              <span className="hidden text-slate-700 sm:inline">·</span>
              <span>Supports Lectra, Gerber, Tuka &amp; Optitex exports</span>
            </div>
            <p className="text-slate-600">
              &copy; {new Date().getFullYear()} ShapeShifter. All rights reserved.
            </p>
          </footer>

          {/* ---------- Info / How-it-works modal ---------- */}
          {infoOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setInfoOpen(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label="About ThreadValidate CAD"
                className="animate-scale-in w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Info className="h-5 w-5 text-brand-400" />
                    <h3 className="text-base font-bold text-white">About ThreadValidate CAD</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInfoOpen(false)}
                    aria-label="Close"
                    className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <p className="text-sm leading-relaxed text-slate-300">
                  ThreadValidate CAD checks your apparel CAD packages for completeness and
                  integrity <span className="font-semibold text-slate-100">before they reach the
                  cutting floor</span>, so only production-ready cut plans move forward.
                </p>

                <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-brand-300/80">
                  How to use it
                </p>
                <ol className="mt-2 space-y-2.5">
                  {[
                    'Export your CAD package as a single .zip — one .xlsx cut plan plus your CAD files.',
                    'Drag & drop the .zip onto the upload area, browse for it, or pick it from Google Drive.',
                    'Click Validate. Fix any flagged issues and re-upload until the package passes — the header bar tallies plans that are ready to submit.',
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-slate-300">
                      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-500/15 text-[11px] font-bold text-brand-300 ring-1 ring-brand-500/30">
                        {i + 1}
                      </span>
                      <span className="leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>

                <button
                  type="button"
                  onClick={() => setInfoOpen(false)}
                  className="mt-5 w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  Got it
                </button>
              </div>
            </div>
          )}

          {/* ---------- Simulated Google Drive file browser ---------- */}
          {drivePickerOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setDrivePickerOpen(false)}
            >
              <div
                className="animate-scale-in w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-5 w-5 text-brand-400" />
                    <h3 className="text-base font-bold text-white">Your Google Drive</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrivePickerOpen(false)}
                    className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mb-4 text-xs text-slate-400">
                  {drive.email} · select a CAD package (.zip)
                </p>
                <ul className="space-y-1.5">
                  {DRIVE_FILES.map((entry) => (
                    <li key={entry.name}>
                      <button
                        type="button"
                        onClick={() => pickFromDrive(entry)}
                        className="flex w-full items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-left transition hover:border-brand-400/60 hover:bg-slate-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                      >
                        <FileArchive className="h-5 w-5 shrink-0 text-brand-400" />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-sm text-slate-100">
                            {entry.name}
                          </span>
                          <span className="block text-[11px] text-slate-500">My Drive · CAD Packages</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-center text-[10px] text-slate-600">
                  Simulated Drive for demo — no real Google account is accessed.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// Right-hand status panel: one row per validated cut plan with a green tick
// (passed) or a red cross (failed). Hovering the red cross reveals why it failed.
function CutplanPanel({ cutplans, limit, onClear }) {
  const used = cutplans.length
  return (
    <aside className="w-full shrink-0 rounded-2xl border border-slate-700/60 bg-slate-900/70 p-5 shadow-2xl shadow-black/40 backdrop-blur-sm lg:w-96">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold text-white">
          <ListChecks className="h-5 w-5 text-brand-400" />
          Cut Plan Status
        </h2>
        <span className="rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-0.5 text-xs font-semibold text-slate-400">
          {used}/{limit}
        </span>
      </div>

      {used === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 p-4 text-center text-sm leading-relaxed text-slate-500">
          No cut plans validated yet. Upload a .zip and click Validate to see its status here.
        </p>
      ) : (
        <ul className="space-y-2">
          {cutplans.map((c, i) => (
            <li
              key={i}
              className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            >
              {c.status === 'pass' ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
              ) : (
                <span className="group relative flex shrink-0 cursor-help">
                  <XCircle className="h-5 w-5 text-red-400" />
                  {/* Failure reason — revealed on hover / focus of the red cross. */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-0 top-7 z-20 hidden w-64 rounded-lg border border-red-500/40 bg-slate-950 p-3 text-xs leading-relaxed text-red-100 shadow-xl group-hover:block"
                  >
                    {c.reason || 'Validation failed.'}
                  </span>
                </span>
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-sm text-slate-200"
                title={c.name}
              >
                {c.name}
              </span>
              <span
                className={`shrink-0 text-xs font-bold uppercase tracking-wide ${
                  c.status === 'pass' ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {c.status === 'pass' ? 'Pass' : 'Fail'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {used > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="mt-4 w-full rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-400 transition hover:border-red-400/50 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          Clear list
        </button>
      )}
    </aside>
  )
}

// Small contents chip: green when present/ok, red when missing.
function Chip({ ok, label }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label}
    </span>
  )
}
