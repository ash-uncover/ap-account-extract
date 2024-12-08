import { getDocument } from 'pdfjs-dist'
import * as fs from 'fs'

// #region exitWithError
function exitWithError(msg) {
  console.log('')
  console.log(msg)
  console.log('')
  process.exit(1)
}
// #endregion

// #region listFiles
async function listFiles(input) {
  const inputDir = fs.lstatSync(input)
  if (!inputDir.isDirectory()) {
    exitWithError(`${input} must be a directory`)
  }
  return new Promise((resolve, reject) => {
    const filesList = []
    fs.readdir(input, (err, files) => {
      if (err) {
        reject(err)
      } else {
        files.forEach((file) => {
          const path = `${input}/${file}`
          filesList.push(path)
        })
        resolve(filesList)
      }
    })
  })
}
// #endregion

// #region loadFiles
async function loadFiles() {
  const files = await listFiles('./files')
  const data = []
  for (let file of files) {
    const fileData = await loadFile(file)
    data.push({
      file,
      data: fileData
    })
  }
  return data
}
// #endregion

function dateToString(year, month, day) {
  return `${year}-${`${month}`.padStart('0', 2)}-${`${day}`.padStart('0', 2)}`
}

// #region loadFile
async function loadFile(file) {
  const doc = await getDocument(file).promise

  const [account, date] = file.split('./files/releve_').join('').split('.pdf').join('').split('_')
  const year = parseInt(date.substring(0, 4))
  const month = parseInt(date.substring(4, 6))

  const totalPages = doc._pdfInfo.numPages;
  const data = []
  for (let i = 0; i < totalPages; i++) {
    const pageData = await loadPage(doc, i + 1)
    data.push(...pageData)
  }
  return data.map(entry => {
    const dateEntry = entry.date
    if (dateEntry.month === 12 && month === 1) {
      dateEntry.year = year - 1
    } else if (dateEntry.month === 1 && month === 12) {
      dateEntry.year = year + 1
    } else {
      dateEntry.year = year
    }
    entry.date = `${dateEntry.year}-${dateEntry.month}-${dateEntry.day}`
    entry.account = account
    return entry
  })
}
// #endregion

// #region loadPage
async function loadPage(doc, num) {
  const data = []
  const page = await doc.getPage(num)
  const content = await page.getTextContent()
  let step = 0
  let current = {}
  content.items.forEach(
    item => {
      const str = item.str
      if (step === 0) {
        const test = str.length === 5 && str[2] == '/'
        if (test) {
          const day = parseInt(str.substring(0, 2))
          const month = parseInt(str.substring(3, 5))
          current.date = {
            day,
            month
          }
          step = 1
        }
      } else {
        switch (step) {
          case 1: {
            step++
            break
          }
          case 2: {
            step++
            current.label1 = str
            break
          }
          case 3: {
            if (str.trim()) {
              current.label1 += ' ' + str
            } else {
              step++
            }
            break
          }
          case 4: {
            if (current.label1.startsWith('CHEQUE')) {
              str.split(' ').pop()
              current.value = parseFloat(str.split(',').join('.').split(' ').join(''))
              const [label1, n, label2] = current.label1.split(' ')
              current.label1 = label1
              current.label2 = label2
              current.isCredit = false
              data.push(current)
              current = {}
              step = 0
            } else if (current.label1 == "4 REMISE COMMERCIALE D'AGIOS") {
              str.split(' ').pop()
              current.value = parseFloat(str.split(',').join('.').split(' ').join(''))
              current.label2 = ''
              current.isCredit = true
              data.push(current)
              current = {}
              step = 0
            } else {
              step++
              current.label2 = str
            }
            break
          }
          case 5: {
            if (str.trim()) {
              current.label2 += ' ' + str
            } else {
              step++
            }
            break
          }
          case 6: {
            current.value = parseFloat(str.split(',').join('.').split(' ').join(''))
            current.valueRaw = str
            if (
              (current.label1.startsWith('VIREMENT') && !current.label1.startsWith('VIREMENT POUR')) ||
              (current.label1 === 'CREDIT CARTE BANCAIRE') ||
              (current.label1 === '4 AVANTAGE SEUIL DE NON-PERCEPTION')
            ) {
              current.isCredit = true
            } else {
              current.isCredit = false
            }
            if (isNaN(current.value)) {
              console.log(current)
            }
            data.push(current)
            current = {}
            step = 0
            break
          }
        }
      }
    }
  )
  return data
}
// #endregion

function computeBalance(data) {
  const balance = data.reduce((acc, entry) => {
    if (entry.isCredit) {
      acc.credit += entry.value
    } else {
      acc.debit += entry.value
    }
    return acc
  }, { credit: 0, debit: 0 })

  balance.credit = Math.round((balance.credit + Number.EPSILON) * 100) / 100
  balance.debit = Math.round((balance.debit + Number.EPSILON) * 100) / 100
  return balance
}

// #region formatEntry
function formatEntry(entry) {
  const value = entry.value.toFixed(2).split('.').join(',')
  return `${entry.account};${entry.date};${entry.label1};${entry.label2};${entry.isCredit ? '' : '-'}${value}`
}
function formatEntryData(entry) {
  const value = entry.value.toFixed(2).split('.').join(',')
  return `${entry.account};${entry.date};${entry.label1};${entry.label2};${entry.isCredit ? '' : '-'}${value};${entry.category1};${entry.category2}`
}
// #endregion

// #region searchInEntry
function searchInEntry(entry, search) {
  if (Array.isArray(search)) {
    return search.some(s => searchInEntry(entry, s))
  }
  return entry.label1.toUpperCase().includes(search) || entry.label2.toUpperCase().includes(search)
}

// #region SCRIPT
try {
  const data = await loadFiles()
  const dataLines = []
  const lines = ['ACCOUNT;DATE;LABEL1;LABEL2;VALUE']
  data.forEach(entry => {
    const balance = computeBalance(entry.data)
    console.log(entry.file, entry.data.length, `-${balance.debit}`, `+${balance.credit}`)
    entry.data.forEach(entry => {
      dataLines.push(entry)
      lines.push(formatEntry(entry))
    })
  })
  fs.writeFileSync('./public/data.csv', lines.join('\n'))

  let count = 0
  dataLines.forEach((entry) => {
    if (entry.isCredit) {
      if (entry.label1.startsWith('VIREMENT')) {
        if (searchInEntry(entry, 'CAF')) {
          entry.category1 = 'VIREMENT EXTERNE'
          entry.category2 = 'CAF'
        } else if (searchInEntry(entry, 'ELECTRICITE')) {
          entry.category1 = 'VIREMENT EXTERNE'
          entry.category2 = 'OTHERS'
        } else if (searchInEntry(entry, 'DGFIP')) {
          entry.category1 = 'VIREMENT EXTERNE'
          entry.category2 = 'OTHERS'
        } else if (searchInEntry(entry, 'MAILLARD')) {
          entry.category1 = 'VIREMENT INTERNE'
          entry.category2 = 'ANTOINE'
        } else if (searchInEntry(entry, 'POUZOULET')) {
          entry.category1 = 'VIREMENT INTERNE'
          entry.category2 = 'BULLE'
        } else {
          entry.category1 = 'VIREMENT EXTERNE'
          entry.category2 = 'OTHERS'
        }
      } else {
        entry.category1 = 'VIREMENT EXTERNE'
        entry.category2 = 'OTHERS'
      }
    } else {
      if (searchInEntry(entry, ['AMAZON', 'AMZ DIGITAL'])) {
        entry.category1 = 'ACHATS'
        entry.category2 = 'AMAZON'
      } else if (searchInEntry(entry, 'EBAY')) {
        entry.category1 = 'ACHATS'
        entry.category2 = 'EBAY'
      } else if (searchInEntry(entry, ['CAROLL', 'ZALANDO', 'DAMART', 'LA HALLE', 'SAINTJAMESOUTL'])) {
        entry.category1 = 'ACHATS'
        entry.category2 = 'VETEMENTS'
      } else if (searchInEntry(entry, ['ALICE DELICE', 'DECATHLON', 'REDBUBBLE.COM', 'MARIONNAUD', "CHEMINS D'ENCR", "LES P'TITS PAP", 'MATHON.FR'])) {
        entry.category1 = 'ACHATS'
        entry.category2 = 'DIVERS'
      } else if (searchInEntry(entry, ['BELIN EDUCATIO', 'NUMWORKS'])) {
        entry.category1 = 'ACHATS'
        entry.category2 = 'EDUCATION'


      } else if (searchInEntry(entry, 'MAISON ET COMPA')) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'MENAGE'
      } else if (searchInEntry(entry, 'COTISATION TRIM')) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'BANQUE'
      } else if (searchInEntry(entry, ['IRREGULARITES', 'MINIMUM FORFAITAIRE TRIMESTRIEL', 'INTERETS DEBITEURS'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'PENALITES'
      } else if (searchInEntry(entry, ['RATP', 'SNCF', 'STATIONNEMENT', 'VELOBO'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'TRANSPORT'
      } else if (searchInEntry(entry, ['PRELEVEMENT DE EDF'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'ELECTRICITE'
      } else if (searchInEntry(entry, ['SEFO-SOCIETE'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'EAU'
      } else if (searchInEntry(entry, ['PRELEVEMENT DE DIRECTION GENERALE'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'IMPOTS'
      } else if (searchInEntry(entry, ['CORIOLIS', 'BOUYGUES'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'TELEPHONE'
      } else if (searchInEntry(entry, ['CMIDY'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'CANTINE'
      } else if (searchInEntry(entry, ['PRELEVEMENT DE FACTURATION MULTIACT'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'GARDERIE'
      } else if (searchInEntry(entry, ['PENSION MELH'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'MELH'
      } else if (searchInEntry(entry, ['CARREFOUR', 'TOTAL MKT FR', 'MONOP', 'FRANPRIX', 'SEAZON', 'MAGASIN U', 'MAISON PONCET', 'FOURNIL GARE', 'GOUT MORNIN', 'HUIT A HUIT', 'LECLERC', 'LES 3 EPIS', 'LE FOURNIL', 'AU FOURNIL', 'CENTRE E.LECLE', 'ACHAT CB UTILE', 'LE PETIT CASIN'])) {
        entry.category1 = 'CHARGES'
        entry.category2 = 'NOURRITURE'

      } else if (searchInEntry(entry, ['PHARMACIE', 'PHARMA CONFLAN', 'NOUVELLE PHARM'])) {
        entry.category1 = 'SANTE'
        entry.category2 = 'PHARMACIE'
      } else if (searchInEntry(entry, ['DR BOUBOUR', 'SELARL CABINET', 'TELECONSULTATI', 'DOCTEUR SZWARC', 'PEREIRA DUARTE', 'DR LUMBROSO', 'CB HOMEREZ'])) {
        entry.category1 = 'SANTE'
        entry.category2 = 'MEDECIN'
      } else if (searchInEntry(entry, ['NGUYEN JEREMIE'])) {
        entry.category1 = 'SANTE'
        entry.category2 = 'PSEUDO-MEDECIN'

      } else if (searchInEntry(entry, ['NETFLIX', 'SPOTIFY'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'NUMERIQUE'
      } else if (searchInEntry(entry, ["L'ESCALE", 'BURGER KING', 'AU FOUR GAULOI', 'AUX DELICES DE', 'SUSHI MAKI78', 'LE BIJOU BAR', 'UBER *EATS', 'SUMUP *LE BIS', 'L AMNESIA', 'PRADAL ET BELG', 'T BAO', 'LE JET 7 SC', 'LE GALWAY', 'LA TAVERNE', 'LA PETITE ITAL'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'RESTAU'
      } else if (searchInEntry(entry, ['ASVOLT', 'MERCURE', 'BOOKING.COM', 'PISC GDS BAINS', "CABA-CENTR'AQU", 'SUMUP *ALAVOS', 'BAX - GOMBERT', 'SARL MOUMINOUX', 'TOURISTES ASSO'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'VACANCES'
      } else if (searchInEntry(entry, ['NATURE ET DECO', 'NATURE DECOUVE', 'LE GRAND CERCL', 'TEMPUS FUGIT', 'DECITRE', 'CHOCO-STORY'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'DIVERS'
      } else if (searchInEntry(entry, ['CAFE DE LA GAR', 'LE MILWAUKEE', 'LES ESTERLINS', 'SNC CONFLANS', 'AU SAINT HONOR', 'MATHOLINI', 'PMU 001046736'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'TABAC'
      } else if (searchInEntry(entry, ['CLUB PHILATELI', 'TENNIS PADEL', 'MJC LES TERRAS'])) {
        entry.category1 = 'LOISIRS'
        entry.category2 = 'ACTIVITES'

      } else if (searchInEntry(entry, ['LW-ALVEUS'])) {
        entry.category1 = 'EDUCATION'
        entry.category2 = 'ANGLAIS'

      } else if (searchInEntry(entry, ['FEBSTA'])) {
        entry.category1 = 'FEBSTA'
        entry.category2 = '??'

      } else if (searchInEntry(entry, ['CHEQUE'])) {
        entry.category1 = 'CHEQUE'
        entry.category2 = '??'

      } else if (searchInEntry(entry, ['RETRAIT DAB'])) {
        entry.category1 = 'RETRAIT DAB'
        entry.category2 = '??'

      } else {
        console.log(entry)
        count++
      }
    }
  });
  console.log('count', count)
  fs.writeFileSync('./data/data2.csv', dataLines.map(formatEntryData).join('\n'))
} catch (error) {
  exitWithError(error)
}
// #endregion
