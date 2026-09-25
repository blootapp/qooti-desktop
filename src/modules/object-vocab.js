// Bilingual object vocabulary for content search.
//
// CLIP scores images against the ENGLISH label (it's English-trained); the Uzbek word is
// stored alongside so a search in either language matches. Each entry is [english, uzbek].
// Uzbek uses the modern Latin script. Extend freely — after changing this, hit
// Settings → Reindex to re-analyze the existing library.

export const OBJECT_VOCAB = [
  // ── People ──
  ['person','odam'],['man','erkak'],['woman','ayol'],['child','bola'],['boy','o‘g‘il bola'],['girl','qiz bola'],['baby','chaqaloq'],['teenager','o‘smir'],['old man','chol'],['old woman','kampir'],['crowd','olomon'],['family','oila'],['couple','juftlik'],['face','yuz'],['eye','ko‘z'],['hand','qo‘l'],['hair','soch'],['smile','tabassum'],['beard','soqol'],['worker','ishchi'],['doctor','shifokor'],['soldier','askar'],['police','politsiya'],['chef','oshpaz'],['student','talaba'],['athlete','sportchi'],['dancer','raqqosa'],['musician','musiqachi'],['artist','rassom'],

  // ── Animals ──
  ['dog','it'],['cat','mushuk'],['bird','qush'],['horse','ot'],['cow','sigir'],['sheep','qo‘y'],['goat','echki'],['pig','cho‘chqa'],['chicken','tovuq'],['rooster','xo‘roz'],['duck','o‘rdak'],['rabbit','quyon'],['mouse','sichqon'],['lion','sher'],['tiger','yo‘lbars'],['bear','ayiq'],['elephant','fil'],['monkey','maymun'],['deer','kiyik'],['fox','tulki'],['wolf','bo‘ri'],['camel','tuya'],['donkey','eshak'],['snake','ilon'],['frog','qurbaqa'],['turtle','toshbaqa'],['fish','baliq'],['shark','akula'],['whale','kit'],['dolphin','delfin'],['crab','qisqichbaqa'],['butterfly','kapalak'],['bee','asalari'],['ant','chumoli'],['spider','o‘rgimchak'],['insect','hasharot'],['owl','boyo‘g‘li'],['eagle','burgut'],['penguin','pingvin'],['parrot','to‘tiqush'],['peacock','tovus'],

  // ── Nature & landscape ──
  ['mountain','tog‘'],['hill','tepalik'],['rock','tosh'],['cliff','qoya'],['cave','g‘or'],['valley','vodiy'],['forest','o‘rmon'],['jungle','o‘rmon-jangal'],['tree','daraxt'],['leaf','barg'],['branch','shox'],['grass','o‘t'],['flower','gul'],['rose','atirgul'],['tulip','lola'],['sunflower','kungaboqar'],['plant','o‘simlik'],['cactus','kaktus'],['mushroom','qo‘ziqorin'],['fruit tree','mevali daraxt'],['field','dala'],['garden','bog‘'],['park','park'],['desert','cho‘l'],['beach','plyaj'],['island','orol'],['ocean','okean'],['sea','dengiz'],['wave','to‘lqin'],['river','daryo'],['lake','ko‘l'],['waterfall','sharshara'],['snow','qor'],['ice','muz'],['sky','osmon'],['cloud','bulut'],['sun','quyosh'],['moon','oy'],['star','yulduz'],['sunset','quyosh botishi'],['sunrise','tong'],['rainbow','kamalak'],['lightning','chaqmoq'],['rain','yomg‘ir'],['fog','tuman'],['fire','olov'],['smoke','tutun'],

  // ── Food & drink ──
  ['food','ovqat'],['bread','non'],['rice','guruch'],['pasta','makaron'],['noodles','ugra'],['soup','sho‘rva'],['salad','salat'],['pizza','pitsa'],['burger','burger'],['sandwich','buterbrod'],['meat','go‘sht'],['chicken meat','tovuq go‘shti'],['kebab','kabob'],['fish dish','baliq taomi'],['egg','tuxum'],['cheese','pishloq'],['butter','sariyog‘'],['milk','sut'],['yogurt','yogurt'],['honey','asal'],['sugar','shakar'],['salt','tuz'],['fruit','meva'],['apple','olma'],['banana','banan'],['orange','apelsin'],['grapes','uzum'],['watermelon','tarvuz'],['melon','qovun'],['strawberry','qulupnay'],['cherry','gilos'],['peach','shaftoli'],['lemon','limon'],['pomegranate','anor'],['fig','anjir'],['apricot','o‘rik'],['vegetable','sabzavot'],['tomato','pomidor'],['potato','kartoshka'],['onion','piyoz'],['carrot','sabzi'],['cucumber','bodring'],['pepper','qalampir'],['garlic','sarimsoq'],['corn','makkajo‘xori'],['cake','tort'],['cookie','pechene'],['chocolate','shokolad'],['ice cream','muzqaymoq'],['candy','konfet'],['coffee','qahva'],['tea','choy'],['juice','sharbat'],['water','suv'],['wine','vino'],['beer','pivo'],['bottle','shisha'],['cup','chashka'],['mug','krujka'],['glass','stakan'],['plate','tarelka'],['bowl','kosa'],['spoon','qoshiq'],['fork','vilka'],['knife','pichoq'],['pot','qozon'],['pan','tova'],['teapot','choynak'],

  // ── Vehicles ──
  ['car','mashina'],['truck','yuk mashinasi'],['bus','avtobus'],['van','mikroavtobus'],['taxi','taksi'],['motorcycle','mototsikl'],['bicycle','velosiped'],['scooter','samokat'],['train','poyezd'],['subway','metro'],['tram','tramvay'],['airplane','samolyot'],['helicopter','vertolyot'],['boat','qayiq'],['ship','kema'],['yacht','yaxta'],['rocket','raketa'],['tractor','traktor'],['ambulance','tez yordam'],['fire truck','o‘t o‘chirish mashinasi'],['wheel','g‘ildirak'],['tire','shina'],['engine','dvigatel'],

  // ── Buildings & places ──
  ['building','bino'],['skyscraper','osmono‘par bino'],['house','uy'],['apartment','kvartira'],['hut','kulba'],['castle','qasr'],['palace','saroy'],['mosque','masjid'],['church','cherkov'],['temple','ibodatxona'],['tower','minora'],['bridge','ko‘prik'],['tunnel','tunnel'],['stadium','stadion'],['school','maktab'],['hospital','shifoxona'],['hotel','mehmonxona'],['restaurant','restoran'],['cafe','kafe'],['shop','do‘kon'],['market','bozor'],['factory','zavod'],['warehouse','ombor'],['office','ofis'],['library','kutubxona'],['museum','muzey'],['airport','aeroport'],['station','bekat'],['farm','ferma'],['ruins','xarobalar'],['city','shahar'],['village','qishloq'],['street','ko‘cha'],['road','yo‘l'],['highway','avtomagistral'],['skyline','shahar manzarasi'],

  // ── Home & furniture ──
  ['door','eshik'],['window','deraza'],['stairs','zinapoya'],['roof','tom'],['wall','devor'],['fence','panjara'],['gate','darvoza'],['chair','stul'],['table','stol'],['desk','yozuv stoli'],['sofa','divan'],['bed','karavot'],['shelf','javon'],['cabinet','shkaf'],['drawer','tortma'],['mirror','oyna'],['lamp','chiroq'],['clock','soat'],['vase','vaza'],['curtain','parda'],['carpet','gilam'],['pillow','yostiq'],['blanket','ko‘rpa'],['towel','sochiq'],['candle','sham'],['picture frame','surat romkasi'],['fireplace','kamin'],['stove','pech'],['refrigerator','muzlatgich'],['washing machine','kir yuvish mashinasi'],['sink','rakovina'],['toilet','hojatxona'],['bathtub','vanna'],['broom','supurgi'],['bucket','chelak'],['key','kalit'],['lock','qulf'],

  // ── Technology ──
  ['phone','telefon'],['smartphone','smartfon'],['laptop','noutbuk'],['computer','kompyuter'],['monitor','monitor'],['keyboard','klaviatura'],['mouse','sichqoncha'],['tablet','planshet'],['camera','kamera'],['headphones','naushnik'],['speaker','karnay'],['microphone','mikrofon'],['television','televizor'],['remote','pult'],['printer','printer'],['router','router'],['cable','kabel'],['charger','zaryadlagich'],['battery','batareya'],['robot','robot'],['drone','dron'],['satellite','sun‘iy yo‘ldosh'],['light bulb','lampochka'],['flashlight','fonar'],

  // ── Office & stationery ──
  ['book','kitob'],['magazine','jurnal'],['newspaper','gazeta'],['notebook','daftar'],['pen','ruchka'],['pencil','qalam'],['paper','qog‘oz'],['envelope','konvert'],['stamp','marka'],['map','xarita'],['calendar','kalendar'],['scissors','qaychi'],['ruler','chizg‘ich'],['folder','papka'],['box','quti'],['cardboard box','karton quti'],['package','paket'],['gift','sovg‘a'],['bag','sumka'],['backpack','ryukzak'],['suitcase','chamadon'],['basket','savat'],['wallet','hamyon'],['money','pul'],['coin','tanga'],['credit card','plastik karta'],

  // ── Clothing & accessories ──
  ['shirt','ko‘ylak'],['t-shirt','futbolka'],['jacket','kurtka'],['coat','palto'],['dress','libos'],['skirt','yubka'],['jeans','jinsi'],['pants','shim'],['suit','kostyum'],['sweater','sviter'],['hat','shlyapa'],['cap','kepka'],['helmet','dubulg‘a'],['scarf','sharf'],['tie','galstuk'],['gloves','qo‘lqop'],['shoe','oyoq kiyim'],['sneaker','krossovka'],['boot','etik'],['sandal','sandal'],['sock','paypoq'],['belt','kamar'],['glasses','ko‘zoynak'],['sunglasses','quyosh ko‘zoynagi'],['watch','qo‘l soati'],['ring','uzuk'],['necklace','marjon'],['earring','sirg‘a'],['bracelet','bilaguzuk'],['umbrella','soyabon'],

  // ── Tools & misc ──
  ['hammer','bolg‘a'],['wrench','gayka kaliti'],['screwdriver','otvertka'],['saw','arra'],['drill','drel'],['axe','bolta'],['ladder','narvon'],['rope','arqon'],['chain','zanjir'],['nail','mix'],['brush','cho‘tka'],['paint','bo‘yoq'],['shovel','belkurak'],['knife tool','pichoq'],['toolbox','asbob qutisi'],

  // ── Sports & play ──
  ['ball','to‘p'],['football','futbol to‘pi'],['basketball','basketbol'],['soccer','futbol'],['tennis','tennis'],['volleyball','voleybol'],['skateboard','skeytbord'],['surfboard','serfing taxtasi'],['ski','chang‘i'],['bicycle sport','velosport'],['boxing','boks'],['chess','shaxmat'],['dice','zar'],['playing card','o‘yin kartasi'],['toy','o‘yinchoq'],['teddy bear','ayiqcha'],['doll','qo‘g‘irchoq'],['kite','varrak'],['balloon','sharcha'],['trophy','kubok'],['medal','medal'],

  // ── Music & art ──
  ['guitar','gitara'],['piano','pianino'],['violin','skripka'],['drum','baraban'],['trumpet','karnay-surnay'],['flute','nay'],['painting','rasm'],['drawing','chizma'],['sculpture','haykal'],['statue','haykal'],['graffiti','graffiti'],['mural','devoriy rasm'],['poster','plakat'],['photograph','fotosurat'],

  // ── Design & UI (this app's world) ──
  ['logo','logotip'],['icon','belgi'],['chart','diagramma'],['graph','grafik'],['diagram','sxema'],['infographic','infografika'],['screenshot','skrinshot'],['user interface','interfeys'],['website','veb-sayt'],['mobile app','mobil ilova'],['dashboard','boshqaruv paneli'],['wireframe','karkas'],['mockup','maket'],['business card','tashrif qog‘ozi'],['packaging','qadoqlash'],['label','yorliq'],['banner','banner'],['menu','menyu'],['button','tugma'],['typography','tipografika'],['handwriting','qo‘lyozma'],['calligraphy','xattotlik'],

  // ── Abstract / style ──
  ['text','matn'],['number','raqam'],['pattern','naqsh'],['texture','tekstura'],['gradient','gradient'],['abstract','abstrakt'],['geometry','geometriya'],['portrait','portret'],['landscape','manzara'],['black and white','oq-qora'],['neon','neon'],['minimal','minimalizm'],['vintage','vintaj'],['collage','kollaj'],['3d render','3d render'],['shadow','soya'],['reflection','aks'],['silhouette','siluet'],
]
