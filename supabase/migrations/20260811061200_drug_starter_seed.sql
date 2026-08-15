-- ============================================================================
-- Migration:  drug_starter_seed
--
-- ############################################################################
-- #  STARTER DATASET — NOT A CERTIFIED DRUG DATABASE.                        #
-- #                                                                          #
-- #  ~50 common Indian OPD drugs and ~25 well-known interaction pairs. Its    #
-- #  only job is to make the severity-driven interaction/allergy behaviour    #
-- #  real and testable. It is NOT clinically reviewed, NOT exhaustive, and    #
-- #  NOT a substitute for a licensed drug-interaction service.                #
-- #                                                                          #
-- #  Absence of a finding is NOT evidence of safety. This is why              #
-- #  check_prescription_safety() reports status='partial' the moment any       #
-- #  prescribed drug falls outside this list.                                 #
-- #                                                                          #
-- #  Before a real clinic prescribes against this: either get it clinically   #
-- #  reviewed or replace it with a licensed data source. Tracked in           #
-- #  Memory.md §6.                                                           #
-- ############################################################################
--
-- Lives in a migration rather than seed.sql because it is reference data the
-- application logic depends on, not sample data — check_prescription_safety()
-- is meaningless without it, so it must travel with the schema to every
-- environment. supabase/seed.sql is for dev fixtures only.
--
-- Idempotent: ON CONFLICT DO NOTHING against the natural keys, so re-running is
-- harmless.
--
-- Prices are indicative MRPs used only to auto-price a billing line; they are not
-- maintained and will drift. GST rate is left NULL (meaning "default medicine
-- rate") except where a drug is in the exempt life-saving category.
-- ============================================================================

insert into public.drugs
  (brand_name, generic_name, form, strength, drug_class, allergy_tags, interaction_generics, mrp, gst_rate, is_otc, notes)
values
  -- ---- analgesics / antipyretics ----
  ('Crocin',        'Paracetamol',              'tablet', '500 mg', 'analgesic/antipyretic', '{}',                          '{}',                                 15.00, null, true,  null),
  ('Dolo 650',      'Paracetamol',              'tablet', '650 mg', 'analgesic/antipyretic', '{}',                          '{}',                                 30.00, null, true,  null),
  ('Combiflam',     'Ibuprofen + Paracetamol',  'tablet', '400/325 mg', 'NSAID combination', '{nsaid}',                     '{ibuprofen,paracetamol}',            45.00, null, false, 'Fixed-dose combination'),
  ('Brufen',        'Ibuprofen',                'tablet', '400 mg', 'NSAID',                 '{nsaid}',                     '{}',                                 25.00, null, false, null),
  ('Voveran',       'Diclofenac',               'tablet', '50 mg',  'NSAID',                 '{nsaid}',                     '{}',                                 35.00, null, false, null),
  ('Sumo',          'Nimesulide + Paracetamol', 'tablet', '100/325 mg', 'NSAID combination', '{nsaid}',                     '{nimesulide,paracetamol}',           48.00, null, false, 'Fixed-dose combination'),
  ('Meftal Spas',   'Mefenamic acid + Dicyclomine', 'tablet', '250/10 mg', 'NSAID combination', '{nsaid}',                  '{mefenamic acid,dicyclomine}',       52.00, null, false, 'Antispasmodic combination'),
  ('Ecosprin',      'Aspirin',                  'tablet', '75 mg',  'antiplatelet/NSAID',    '{nsaid,salicylate,aspirin}',  '{}',                                 12.00, null, false, 'Low-dose antiplatelet'),
  ('Tramazac',      'Tramadol',                 'tablet', '50 mg',  'opioid analgesic',      '{opioid}',                    '{}',                                 60.00, null, false, null),

  -- ---- antibiotics ----
  ('Mox',           'Amoxicillin',              'capsule', '500 mg', 'penicillin antibiotic', '{penicillin,beta_lactam}',   '{}',                                 65.00, null, false, null),
  ('Augmentin 625', 'Amoxicillin + Clavulanic acid', 'tablet', '500/125 mg', 'penicillin antibiotic', '{penicillin,beta_lactam}', '{amoxicillin,clavulanic acid}', 185.00, null, false, 'Fixed-dose combination'),
  ('Azithral 500',  'Azithromycin',             'tablet', '500 mg', 'macrolide antibiotic',  '{macrolide}',                 '{}',                                 105.00, null, false, null),
  ('Cifran 500',    'Ciprofloxacin',            'tablet', '500 mg', 'fluoroquinolone',       '{fluoroquinolone}',           '{}',                                 55.00, null, false, null),
  ('Taxim-O',       'Cefixime',                 'tablet', '200 mg', 'cephalosporin',         '{cephalosporin,beta_lactam}', '{}',                                 95.00, null, false, null),
  ('Monocef',       'Ceftriaxone',              'injection', '1 g',  'cephalosporin',        '{cephalosporin,beta_lactam}', '{}',                                 75.00, null, false, null),
  ('Flagyl',        'Metronidazole',            'tablet', '400 mg', 'nitroimidazole',        '{}',                          '{}',                                 30.00, null, false, null),
  ('Doxt',          'Doxycycline',              'capsule', '100 mg', 'tetracycline',         '{tetracycline}',              '{}',                                 40.00, null, false, null),
  ('Septran DS',    'Sulfamethoxazole + Trimethoprim', 'tablet', '800/160 mg', 'sulfonamide', '{sulfa,sulfonamide}',        '{sulfamethoxazole,trimethoprim}',    38.00, null, false, 'Co-trimoxazole'),

  -- ---- gastro ----
  ('Pan 40',        'Pantoprazole',             'tablet', '40 mg',  'proton pump inhibitor', '{}',                          '{}',                                 95.00, null, false, null),
  ('Omez',          'Omeprazole',               'capsule', '20 mg', 'proton pump inhibitor', '{}',                          '{}',                                 60.00, null, false, null),
  ('Rantac',        'Ranitidine',               'tablet', '150 mg', 'H2 blocker',            '{}',                          '{}',                                 28.00, null, true,  null),
  ('Digene',        'Antacid combination',      'tablet', null,     'antacid',               '{}',                          '{}',                                 42.00, null, true,  null),
  ('Ondem',         'Ondansetron',              'tablet', '4 mg',   'antiemetic',            '{}',                          '{}',                                 35.00, null, false, null),
  ('Domstal',       'Domperidone',              'tablet', '10 mg',  'prokinetic',            '{}',                          '{}',                                 32.00, null, false, null),
  ('Electral',      'Oral rehydration salts',   'powder', null,     'electrolyte',           '{}',                          '{}',                                 22.00, null, true,  null),

  -- ---- respiratory / allergy ----
  ('Allegra 120',   'Fexofenadine',             'tablet', '120 mg', 'antihistamine',         '{}',                          '{}',                                 85.00, null, false, null),
  ('Cetzine',       'Cetirizine',               'tablet', '10 mg',  'antihistamine',         '{}',                          '{}',                                 18.00, null, true,  null),
  ('Avil',          'Pheniramine',              'tablet', '25 mg',  'antihistamine',         '{}',                          '{}',                                 15.00, null, false, null),
  ('Montair LC',    'Montelukast + Levocetirizine', 'tablet', '10/5 mg', 'antiasthmatic combination', '{}',                 '{montelukast,levocetirizine}',       165.00, null, false, 'Fixed-dose combination'),
  ('Asthalin',      'Salbutamol',               'inhaler', '100 mcg', 'bronchodilator',      '{}',                          '{}',                                 130.00, null, false, null),
  ('Deriphyllin',   'Etophylline + Theophylline', 'tablet', '77/23 mg', 'bronchodilator',    '{}',                          '{etophylline,theophylline}',         48.00, null, false, 'Fixed-dose combination'),
  ('Wysolone',      'Prednisolone',             'tablet', '10 mg',  'corticosteroid',        '{}',                          '{}',                                 38.00, null, false, null),

  -- ---- cardiometabolic ----
  ('Glycomet 500',  'Metformin',                'tablet', '500 mg', 'biguanide',             '{}',                          '{}',                                 32.00, null, false, null),
  ('Amaryl 1',      'Glimepiride',              'tablet', '1 mg',   'sulfonylurea',          '{sulfa,sulfonamide}',         '{}',                                 68.00, null, false, 'Sulfonylurea — caution with sulfa allergy'),
  ('Human Actrapid','Insulin human',            'injection', '40 IU/ml', 'insulin',          '{}',                          '{}',                                 165.00, 0,   false, 'Life-saving category — GST exempt, hence gst_rate 0'),
  ('Telma 40',      'Telmisartan',              'tablet', '40 mg',  'ARB antihypertensive',  '{}',                          '{}',                                 110.00, null, false, null),
  ('Losar 50',      'Losartan',                 'tablet', '50 mg',  'ARB antihypertensive',  '{}',                          '{}',                                 72.00, null, false, null),
  ('Amlong 5',      'Amlodipine',               'tablet', '5 mg',   'calcium channel blocker', '{}',                        '{}',                                 45.00, null, false, null),
  ('Aten 50',       'Atenolol',                 'tablet', '50 mg',  'beta blocker',          '{}',                          '{}',                                 38.00, null, false, null),
  ('Atorva 10',     'Atorvastatin',             'tablet', '10 mg',  'statin',                '{}',                          '{}',                                 88.00, null, false, null),
  ('Rosuvas 10',    'Rosuvastatin',             'tablet', '10 mg',  'statin',                '{}',                          '{}',                                 135.00, null, false, null),
  ('Clopilet 75',   'Clopidogrel',              'tablet', '75 mg',  'antiplatelet',          '{}',                          '{}',                                 78.00, null, false, null),
  ('Warf 5',        'Warfarin',                 'tablet', '5 mg',   'anticoagulant',         '{}',                          '{}',                                 55.00, null, false, 'Narrow therapeutic index — many interactions'),

  -- ---- endocrine / supplements ----
  ('Thyronorm 50',  'Levothyroxine',            'tablet', '50 mcg', 'thyroid hormone',       '{}',                          '{}',                                 145.00, null, false, null),
  ('Shelcal 500',   'Calcium carbonate + Vitamin D3', 'tablet', '500 mg/250 IU', 'supplement', '{}',                        '{calcium carbonate,cholecalciferol}', 105.00, null, true, 'Fixed-dose combination'),
  ('Zincovit',      'Multivitamin + Zinc',      'tablet', null,     'supplement',            '{}',                          '{}',                                 118.00, null, true,  null),
  ('Fefol',         'Ferrous sulphate + Folic acid', 'capsule', '150/0.5 mg', 'haematinic',  '{}',                          '{ferrous sulphate,folic acid}',      62.00, null, true,  'Fixed-dose combination'),

  -- ---- antifungal / antiviral / CNS ----
  ('Forcan 150',    'Fluconazole',              'tablet', '150 mg', 'antifungal',            '{}',                          '{}',                                 45.00, null, false, null),
  ('Zovirax',       'Acyclovir',                'tablet', '400 mg', 'antiviral',             '{}',                          '{}',                                 125.00, null, false, null),
  ('Alprax 0.5',    'Alprazolam',               'tablet', '0.5 mg', 'benzodiazepine',        '{}',                          '{}',                                 42.00, null, false, 'Schedule H1')
on conflict (brand_name, generic_name, strength) do nothing;


-- ============================================================================
-- Interaction pairs.
--
-- generic_a < generic_b is enforced by drug_interactions_canonical_order, so
-- every pair below is written in lexicographic order and the lookup normalises
-- the same way. That is what stops a reversed pair from silently missing.
--
-- Severity drives the UI: only 'high' justifies a hard interrupt (PRD §6.1,
-- rules.md §6.4). Assignments here are conservative but NOT clinically reviewed.
-- ============================================================================

insert into public.drug_interactions (generic_a, generic_b, severity, description, source_note)
values
  -- ---- bleeding risk: the classic high-severity group ----
  ('aspirin',        'warfarin',     'high',
   'Substantially increased bleeding risk. Avoid the combination or monitor INR closely.', 'starter dataset'),
  ('clopidogrel',    'warfarin',     'high',
   'Dual antithrombotic therapy markedly raises major bleeding risk.', 'starter dataset'),
  ('ibuprofen',      'warfarin',     'high',
   'NSAIDs raise bleeding risk and can displace warfarin from protein binding.', 'starter dataset'),
  ('diclofenac',     'warfarin',     'high',
   'NSAIDs raise bleeding risk and can displace warfarin from protein binding.', 'starter dataset'),
  ('metronidazole',  'warfarin',     'high',
   'Metronidazole inhibits warfarin metabolism; INR can rise sharply.', 'starter dataset'),
  ('fluconazole',    'warfarin',     'high',
   'Fluconazole strongly potentiates warfarin. INR monitoring required.', 'starter dataset'),
  ('ciprofloxacin',  'warfarin',     'medium',
   'Fluoroquinolones may potentiate warfarin. Monitor INR.', 'starter dataset'),
  ('aspirin',        'clopidogrel',  'medium',
   'Intentional in some cardiac regimens, but bleeding risk is additive. Confirm it is deliberate.', 'starter dataset'),

  -- ---- respiratory: a genuinely dangerous pairing in asthma ----
  ('atenolol',       'salbutamol',   'high',
   'Beta blockers antagonise beta-agonist bronchodilation and may provoke bronchospasm in asthma.', 'starter dataset'),

  -- ---- CNS depression ----
  ('alprazolam',     'tramadol',     'high',
   'Additive CNS and respiratory depression. Avoid or reduce doses substantially.', 'starter dataset'),

  -- ---- QT prolongation ----
  ('azithromycin',   'ondansetron',  'medium',
   'Both prolong the QT interval; additive risk of arrhythmia.', 'starter dataset'),
  ('domperidone',    'ondansetron',  'medium',
   'Both prolong the QT interval; additive risk of arrhythmia.', 'starter dataset'),

  -- ---- NSAID / antihypertensive ----
  ('ibuprofen',      'losartan',     'medium',
   'NSAIDs blunt the antihypertensive effect and add renal risk, especially in the elderly.', 'starter dataset'),
  ('ibuprofen',      'telmisartan',  'medium',
   'NSAIDs blunt the antihypertensive effect and add renal risk, especially in the elderly.', 'starter dataset'),
  ('aspirin',        'ibuprofen',    'medium',
   'Ibuprofen can blunt the antiplatelet effect of low-dose aspirin. Separate the doses.', 'starter dataset'),

  -- ---- glycaemic control ----
  ('metformin',      'prednisolone', 'medium',
   'Corticosteroids raise blood glucose and can destabilise diabetic control.', 'starter dataset'),
  ('ciprofloxacin',  'glimepiride',  'medium',
   'Fluoroquinolones can cause hypoglycaemia when combined with sulfonylureas.', 'starter dataset'),
  ('atenolol',       'glimepiride',  'medium',
   'Beta blockers mask the adrenergic warning signs of hypoglycaemia.', 'starter dataset'),

  -- ---- absorption / metabolism ----
  ('calcium carbonate', 'levothyroxine', 'medium',
   'Calcium markedly reduces levothyroxine absorption. Separate doses by at least four hours.', 'starter dataset'),
  ('ferrous sulphate',  'levothyroxine', 'medium',
   'Iron reduces levothyroxine absorption. Separate doses by at least four hours.', 'starter dataset'),
  ('levothyroxine',     'pantoprazole',  'low',
   'Reduced gastric acidity can modestly reduce levothyroxine absorption.', 'starter dataset'),
  ('atorvastatin',      'azithromycin',  'low',
   'Small theoretical increase in statin exposure; myopathy risk is low but non-zero.', 'starter dataset'),
  ('amlodipine',        'atorvastatin',  'low',
   'Amlodipine modestly increases atorvastatin exposure. Usually tolerated.', 'starter dataset'),
  ('atorvastatin',      'fluconazole',   'medium',
   'Azole antifungals raise statin exposure and myopathy risk.', 'starter dataset'),
  ('doxycycline',       'ferrous sulphate', 'medium',
   'Iron chelates tetracyclines and substantially reduces absorption. Separate doses.', 'starter dataset')
on conflict (generic_a, generic_b) do nothing;
