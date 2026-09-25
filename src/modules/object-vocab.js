// Bilingual object vocabulary for content search — CONCRETE, detectable objects only
// (based on the COCO / everyday-object label sets: ball, car, book, chair, phone, dog…).
// Deliberately excludes styles/scenes/abstract terms — the auto-tag feature already
// covers those. CLIP scores the ENGLISH label; the Uzbek word is stored alongside so a
// search in either language matches. Each entry is [english, uzbek] (Uzbek Latin script).
// Extend freely — after changing this, hit Settings → Reindex to re-analyze the library.

export const OBJECT_VOCAB = [
  // ── People / body ──
  ['person','odam'],['man','erkak'],['woman','ayol'],['child','bola'],['baby','chaqaloq'],['face','yuz'],['hand','qo‘l'],['eye','ko‘z'],['hair','soch'],

  // ── Animals ──
  ['dog','it'],['cat','mushuk'],['bird','qush'],['horse','ot'],['cow','sigir'],['sheep','qo‘y'],['goat','echki'],['pig','cho‘chqa'],['chicken','tovuq'],['rabbit','quyon'],['mouse','sichqon'],['elephant','fil'],['bear','ayiq'],['lion','sher'],['tiger','yo‘lbars'],['zebra','zebra'],['giraffe','jirafa'],['monkey','maymun'],['deer','kiyik'],['fox','tulki'],['snake','ilon'],['frog','qurbaqa'],['turtle','toshbaqa'],['fish','baliq'],['shark','akula'],['dolphin','delfin'],['whale','kit'],['crab','qisqichbaqa'],['butterfly','kapalak'],['bee','asalari'],['ant','chumoli'],['spider','o‘rgimchak'],['owl','boyo‘g‘li'],['eagle','burgut'],['duck','o‘rdak'],['penguin','pingvin'],['parrot','to‘tiqush'],

  // ── Vehicles ──
  ['car','mashina'],['truck','yuk mashinasi'],['bus','avtobus'],['van','mikroavtobus'],['taxi','taksi'],['motorcycle','mototsikl'],['bicycle','velosiped'],['scooter','samokat'],['train','poyezd'],['airplane','samolyot'],['helicopter','vertolyot'],['boat','qayiq'],['ship','kema'],['tractor','traktor'],['wheel','g‘ildirak'],['tire','shina'],

  // ── Street / outdoor objects ──
  ['traffic light','svetofor'],['stop sign','to‘xtash belgisi'],['fire hydrant','yong‘in gidranti'],['street sign','ko‘cha belgisi'],['bench','skameyka'],['streetlight','ko‘cha chirog‘i'],['bridge','ko‘prik'],['building','bino'],['house','uy'],['tent','chodir'],['statue','haykal'],['fountain','favvora'],

  // ── Food & drink ──
  ['food','ovqat'],['bread','non'],['sandwich','buterbrod'],['pizza','pitsa'],['burger','burger'],['hot dog','xot-dog'],['cake','tort'],['donut','ponchik'],['cookie','pechene'],['ice cream','muzqaymoq'],['egg','tuxum'],['cheese','pishloq'],['banana','banan'],['apple','olma'],['orange','apelsin'],['grapes','uzum'],['strawberry','qulupnay'],['lemon','limon'],['watermelon','tarvuz'],['tomato','pomidor'],['carrot','sabzi'],['potato','kartoshka'],['broccoli','brokkoli'],['corn','makkajo‘xori'],['coffee','qahva'],['tea','choy'],

  // ── Kitchen & tableware ──
  ['bottle','shisha'],['can','banka'],['cup','chashka'],['mug','krujka'],['wine glass','vino qadahi'],['glass','stakan'],['plate','tarelka'],['bowl','kosa'],['spoon','qoshiq'],['fork','vilka'],['knife','pichoq'],['pot','qozon'],['pan','tova'],['teapot','choynak'],

  // ── Furniture & home ──
  ['chair','stul'],['table','stol'],['desk','yozuv stoli'],['sofa','divan'],['bed','karavot'],['shelf','javon'],['cabinet','shkaf'],['mirror','oyna'],['lamp','chiroq'],['clock','soat'],['vase','vaza'],['curtain','parda'],['carpet','gilam'],['pillow','yostiq'],['blanket','ko‘rpa'],['towel','sochiq'],['candle','sham'],['door','eshik'],['window','deraza'],['stairs','zinapoya'],['potted plant','tuvakdagi o‘simlik'],['refrigerator','muzlatgich'],['oven','pech'],['microwave','mikroto‘lqinli pech'],['toaster','toster'],['sink','rakovina'],['toilet','hojatxona'],['bathtub','vanna'],['broom','supurgi'],['bucket','chelak'],['key','kalit'],['lock','qulf'],['umbrella','soyabon'],

  // ── Electronics ──
  ['phone','telefon'],['smartphone','smartfon'],['laptop','noutbuk'],['computer','kompyuter'],['monitor','monitor'],['keyboard','klaviatura'],['mouse','sichqoncha'],['tablet','planshet'],['camera','kamera'],['headphones','naushnik'],['speaker','karnay'],['microphone','mikrofon'],['television','televizor'],['remote','pult'],['printer','printer'],['router','router'],['charger','zaryadlagich'],['battery','batareya'],['game controller','o‘yin pulti'],['light bulb','lampochka'],['flashlight','fonar'],['hair drier','fen'],

  // ── Office & stationery ──
  ['book','kitob'],['magazine','jurnal'],['newspaper','gazeta'],['notebook','daftar'],['pen','ruchka'],['pencil','qalam'],['paper','qog‘oz'],['envelope','konvert'],['box','quti'],['cardboard box','karton quti'],['package','paket'],['bag','sumka'],['backpack','ryukzak'],['suitcase','chamadon'],['handbag','qo‘l sumkasi'],['basket','savat'],['wallet','hamyon'],['money','pul'],['coin','tanga'],['credit card','plastik karta'],['scissors','qaychi'],['ruler','chizg‘ich'],['calendar','kalendar'],['stamp','marka'],['map','xarita'],['poster','plakat'],['flag','bayroq'],

  // ── Clothing & accessories ──
  ['shirt','ko‘ylak'],['t-shirt','futbolka'],['jacket','kurtka'],['coat','palto'],['dress','libos'],['jeans','jinsi'],['pants','shim'],['suit','kostyum'],['sweater','sviter'],['hat','shlyapa'],['cap','kepka'],['helmet','dubulg‘a'],['scarf','sharf'],['tie','galstuk'],['gloves','qo‘lqop'],['shoe','oyoq kiyim'],['sneaker','krossovka'],['boot','etik'],['sock','paypoq'],['belt','kamar'],['glasses','ko‘zoynak'],['sunglasses','quyosh ko‘zoynagi'],['watch','qo‘l soati'],['ring','uzuk'],['necklace','marjon'],

  // ── Sports & play ──
  ['ball','to‘p'],['football','futbol to‘pi'],['basketball','basketbol to‘pi'],['tennis racket','tennis raketkasi'],['baseball bat','beysbol tayoqchasi'],['skateboard','skeytbord'],['surfboard','serfing taxtasi'],['skis','chang‘i'],['snowboard','snoubord'],['frisbee','frisbi'],['kite','varrak'],['dumbbell','gantel'],['toy','o‘yinchoq'],['teddy bear','ayiqcha'],['doll','qo‘g‘irchoq'],['dice','zar'],['chess','shaxmat'],['balloon','sharcha'],['trophy','kubok'],

  // ── Tools ──
  ['hammer','bolg‘a'],['wrench','gayka kaliti'],['screwdriver','otvertka'],['saw','arra'],['drill','drel'],['axe','bolta'],['ladder','narvon'],['rope','arqon'],['nail','mix'],['brush','cho‘tka'],['shovel','belkurak'],['toolbox','asbob qutisi'],

  // ── Musical instruments ──
  ['guitar','gitara'],['piano','pianino'],['violin','skripka'],['drum','baraban'],['trumpet','karnay'],['flute','nay'],

  // ── Nature objects ──
  ['tree','daraxt'],['flower','gul'],['plant','o‘simlik'],['leaf','barg'],['grass','o‘t'],['rock','tosh'],['mountain','tog‘'],['cloud','bulut'],['sun','quyosh'],['moon','oy'],['star','yulduz'],['fire','olov'],['snow','qor'],
]
