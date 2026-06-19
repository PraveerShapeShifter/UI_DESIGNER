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
  uploadFilesToDrive,
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
  Clock,
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

  const tmpNames = baseNames.filter((n) => /\.tmp$/i.test(n))
  const plxNames = baseNames.filter((n) => /\.plx$/i.test(n))
  const pdsNames = baseNames.filter((n) => /\.pds$/i.test(n))
  const tumNames = baseNames.filter((n) => /\.tum$/i.test(n))

  // Identify CAD system from whichever proprietary extension is present.
  let cadType = null
  let cadNames = []
  if      (tmpNames.length) { cadType = 'Gerber'; cadNames = tmpNames }
  else if (plxNames.length) { cadType = 'Lectra'; cadNames = plxNames }
  else if (pdsNames.length) { cadType = 'PDS';    cadNames = pdsNames }
  else if (tumNames.length) { cadType = 'Tuka';   cadNames = tumNames }

  const knownExts = /\.(xlsx|tmp|plx|pds|tum)$/i
  return {
    corrupt: false,
    xlsxNames: baseNames.filter((n) => /\.xlsx$/i.test(n)),
    cadNames,
    cadType,
    tmpNames, // kept so simulateTmpFailures still works for Gerber packages
    otherNames: baseNames.filter((n) => !knownExts.test(n)),
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
  const [isDragging, setIsDragging] = useState(false)
  const [hint, setHint] = useState('')
  const [outcome, setOutcome] = useState('fail') // demo toggle: 'fail' | 'pass'
  // Persistent log (name + pass/fail) for cross-session badge + localStorage.
  const [cutplans, setCutplans] = useState(readCutplans)
  // Unified session queue — each entry holds the File object (in-memory) + live status.
  const [queue, setQueue] = useState(() =>
    readCutplans().map((c, i) => ({
      id: i,
      file: null,
      name: c.name,
      size: null,
      status: c.status,
      reason: c.reason,
    }))
  )
  const idCounter = useRef(queue.length)
  const [isValidating, setIsValidating] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [driveLoading, setDriveLoading] = useState(false)
  const [drivePickerOpen, setDrivePickerOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const driveConfigured = isDriveConfigured()
  const [drive, setDrive] = useState(() =>
    driveConfigured ? getConnection() : { connected: false, email: null },
  )

  const inputRef = useRef(null)

  // Derived values
  const passedCount  = queue.filter((q) => q.status === 'pass').length
  const pendingCount = queue.filter((q) => q.status === 'pending' && q.file).length
  const canValidate  = pendingCount > 0 && !isValidating
  const showZone     = queue.length < MAX_CUTPLANS && !isValidating

  // Persist a completed entry to localStorage (for cross-session badge).
  const recordCutplan = useCallback((entry) => {
    setCutplans((prev) => {
      const next = [...prev, entry].slice(0, MAX_CUTPLANS)
      saveCutplans(next)
      return next
    })
  }, [])

  // Clear everything — queue + localStorage.
  const clearAll = useCallback(() => {
    setQueue([])
    setCutplans([])
    saveCutplans([])
    setHint('')
  }, [])

  // Remove a single queue entry by id; also removes from localStorage if completed.
  const removeFromQueue = useCallback((id) => {
    setQueue((prev) => {
      const removed = prev.find((q) => q.id === id)
      const next = prev.filter((q) => q.id !== id)
      if (removed && (removed.status === 'pass' || removed.status === 'fail')) {
        setCutplans((cp) => {
          const updated = cp.filter((c) => c.name !== removed.name)
          saveCutplans(updated)
          return updated
        })
      }
      return next
    })
  }, [])

  const submitToDrive = useCallback(async () => {
    if (isSubmitting || queue.length === 0) return
    const files = queue.map((q) => q.file).filter(Boolean)
    if (files.length === 0) return
    setIsSubmitting(true)
    try {
      await uploadFilesToDrive(files)
    } finally {
      setIsSubmitting(false)
    }
  }, [isSubmitting, queue])

  // Accept one or more File objects; filters to zips, respects quota.
  const acceptFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []).filter(isZip)
    if (incoming.length === 0) {
      setHint('Only .zip archives are supported. Please export your CAD package as a .zip.')
      return
    }
    const slots = MAX_CUTPLANS - queue.length
    if (slots <= 0) {
      setHint(`You can upload a maximum of ${MAX_CUTPLANS} cut plans. Remove files to make room.`)
      return
    }
    const toAdd = incoming.slice(0, slots)
    if (incoming.length > slots)
      setHint(`Only ${slots} slot(s) remaining — ${incoming.length - slots} file(s) were ignored.`)
    else
      setHint('')
    setQueue((prev) => [
      ...prev,
      ...toAdd.map((f) => ({
        id: ++idCounter.current,
        file: f,
        name: f.name,
        size: f.size,
        status: 'pending',
      })),
    ])
  }, [queue.length])

  // ----- Drag & drop -----
  const onDragOver = (e) => {
    e.preventDefault()
    if (isValidating) return
    setIsDragging(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault()
    setIsDragging(false)
  }
  const onDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (!isValidating) acceptFiles(e.dataTransfer.files)
  }
  const onBrowse  = (e) => acceptFiles(e.target.files)
  const openPicker = () => {
    if (!isValidating) inputRef.current?.click()
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
    if (isValidating || driveLoading) return
    setHint('')
    setDrivePickerOpen(true)
  }

  // Pick a file from the simulated Drive: build that package in-memory, then add to queue.
  const pickFromDrive = async (entry) => {
    setDrivePickerOpen(false)
    setDriveLoading(true)
    try {
      acceptFiles([await buildPackageZip(entry.style, 'valid')])
    } finally {
      setDriveLoading(false)
    }
  }

  // ----- Sequential validation -----
  const validate = async () => {
    if (!canValidate) return
    const pendingItems = queue.filter((q) => q.status === 'pending' && q.file)
    setIsValidating(true)

    for (const item of pendingItems) {
      setQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: 'validating' } : q))

      const [info] = await Promise.all([inspectArchive(item.file), delay(randInt(900, 1700))])

      if (info.corrupt) {
        const reason = 'Archive could not be read — it may be corrupt or not a valid .zip file.'
        setQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: 'fail', reason, cadType: null } : q))
        recordCutplan({ name: item.name, status: 'fail', reason })
        continue
      }

      const cadType = info.cadType
      const structural = []
      if (info.xlsxNames.length === 0) structural.push('Missing spreadsheet (.xlsx)')
      if (info.cadNames.length === 0)  structural.push('Missing CAD files (.tmp / .plx / .pds / .tum)')
      if (structural.length) {
        const reason = structural.join('; ')
        setQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: 'fail', reason, cadType } : q))
        recordCutplan({ name: item.name, status: 'fail', reason })
        continue
      }

      // Per-file failure simulation only applies to Gerber (.tmp) packages for now.
      const failedTmps = cadType === 'Gerber' ? simulateTmpFailures(info.cadNames, outcome) : []
      if (failedTmps.length) {
        const reason =
          `${failedTmps.length} of ${info.cadNames.length} ${cadType} file(s) failed — ` +
          failedTmps.map((f) => `${f.name}: ${f.reason}`).join('; ')
        setQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: 'fail', reason, cadType } : q))
        recordCutplan({ name: item.name, status: 'fail', reason })
      } else {
        setQueue((prev) => prev.map((q) => q.id === item.id ? { ...q, status: 'pass', cadType } : q))
        recordCutplan({ name: item.name, status: 'pass' })
      }
    }

    setIsValidating(false)
  }

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
                <h1 className="flex items-center gap-1.5 text-xl font-extrabold tracking-tight text-white sm:text-2xl">
                  ThreadValidate <span className="text-brand-400">CAD</span>
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    aria-label="About this portal and how to use it"
                    title="What is this? How do I use it?"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-slate-600 bg-slate-800/80 text-slate-400 transition hover:border-brand-400/60 hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </h1>
                <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
                  Pattern &amp; Marker Integrity Suite
                </p>
              </div>
            </div>
            {/* Right: status bar */}
            <div className="flex flex-1 items-center justify-end">
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
                className={`group relative flex w-full flex-col items-center justify-center gap-5 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 sm:py-20 ${
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
                    {isDragging ? 'Release to upload' : 'Drag & drop your .zip files here'}
                  </span>
                  <span className="block text-base text-slate-400">
                    or{' '}
                    <span className="font-medium text-brand-300 underline-offset-2 group-hover:underline">
                      click to browse
                    </span>{' '}
                    and select up to {MAX_CUTPLANS} files
                  </span>
                </span>
                <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/70 px-3.5 py-1.5 text-xs font-medium text-slate-400">
                  <FileArchive className="h-4 w-4" /> Each zip: 1 × .xlsx + one or more .tmp CAD files
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
                          disabled={driveLoading}
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

            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".zip,application/zip,application/x-zip-compressed"
              onChange={onBrowse}
              className="hidden"
            />

            {hint && (
              <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> {hint}
              </p>
            )}

            {/* ---------- Validate button ---------- */}
            {(queue.some((q) => q.status === 'pending') || isValidating) && (
              <button
                type="button"
                onClick={validate}
                disabled={!canValidate}
                className={`mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                  isValidating
                    ? 'cursor-wait bg-brand-500/80 text-slate-950'
                    : canValidate
                      ? 'bg-brand-500 text-slate-950 shadow-lg shadow-brand-500/25 hover:bg-brand-400 active:scale-[0.99]'
                      : 'cursor-not-allowed bg-slate-800 text-slate-500'
                }`}
              >
                {isValidating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {(() => {
                      const cur = queue.find((q) => q.status === 'validating')
                      return cur ? `Validating ${cur.name.replace(/\.zip$/i, '')}…` : 'Validating…'
                    })()}
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" /> Validate Files ({pendingCount})
                  </>
                )}
              </button>
            )}
          </section>

          {/* ---------- Cut plan status panel ---------- */}
          <CutplanPanel
            queue={queue}
            limit={MAX_CUTPLANS}
            onClear={clearAll}
            onDelete={removeFromQueue}
            onSubmit={submitToDrive}
            driveConnected={drive.connected}
            isSubmitting={isSubmitting}
            isValidating={isValidating}
          />
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

// Right-hand status panel: one row per queue entry with live status indicators.
function CutplanPanel({ queue, limit, onClear, onDelete, onSubmit, driveConnected, isSubmitting, isValidating }) {
  const used = queue.length
  const submittableCount = queue.filter((q) => q.file).length

  const statusIcon = (q) => {
    if (q.status === 'pending')    return <Clock className="h-5 w-5 shrink-0 text-slate-500" />
    if (q.status === 'validating') return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-400" />
    if (q.status === 'pass')       return <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
    return (
      <span className="group relative flex shrink-0 cursor-help">
        <XCircle className="h-5 w-5 text-red-400" />
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-7 z-20 hidden w-64 rounded-lg border border-red-500/40 bg-slate-950 p-3 text-xs leading-relaxed text-red-100 shadow-xl group-hover:block"
        >
          {q.reason || 'Validation failed.'}
        </span>
      </span>
    )
  }

  const statusLabel = { pending: 'Pending', validating: 'Validating…', pass: 'Pass', fail: 'Fail' }
  const statusColor = {
    pending:    'text-slate-500',
    validating: 'text-brand-400',
    pass:       'text-emerald-400',
    fail:       'text-red-400',
  }

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
          No files added yet. Drag &amp; drop zip packages above to begin.
        </p>
      ) : (
        <ul className="space-y-2">
          {queue.map((q) => (
            <li
              key={q.id}
              className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            >
              <span className="mt-0.5 shrink-0">{statusIcon(q)}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono text-sm text-slate-200">{q.name}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                  {q.size != null && <span>{formatBytes(q.size)}</span>}
                  {q.size != null && <span className="text-slate-700">·</span>}
                  <span className="font-medium text-slate-400">{q.cadType ?? '—'}</span>
                </span>
              </span>
              <span className={`mt-0.5 shrink-0 text-xs font-bold uppercase tracking-wide ${statusColor[q.status]}`}>
                {statusLabel[q.status]}
              </span>
              <button
                type="button"
                onClick={() => onDelete(q.id)}
                disabled={isValidating}
                aria-label={`Remove ${q.name}`}
                title="Remove"
                className="ml-1 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-500 transition hover:bg-red-500/15 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {used > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {driveConnected && (
            <button
              type="button"
              onClick={onSubmit}
              disabled={isSubmitting || isValidating || submittableCount === 0 || queue.some((q) => q.status === 'pending')}
              title={
                queue.some((q) => q.status === 'pending')
                  ? 'Validate all files before submitting'
                  : submittableCount === 0
                    ? 'Re-validate packages to enable upload'
                    : undefined
              }
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-bold text-slate-950 transition hover:bg-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Uploading to Drive…</>
              ) : (
                <><HardDrive className="h-4 w-4" /> Submit to Drive ({submittableCount})</>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            className="w-full rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-400 transition hover:border-red-400/50 hover:text-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Clear list
          </button>
        </div>
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
