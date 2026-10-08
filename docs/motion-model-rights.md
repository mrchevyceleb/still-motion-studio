# Commercial model path

Checked October 8, 2026. **The independent path is fresh project-owned weights trained only on the creator's CC0 motion, not a different mirror of research weights.** CondMDI remains a separate working research provider. Its commercial checkpoint/output permission is unresolved; the application does not manufacture clearance by labeling MIT code as MIT weights.

## What the primary sources establish

| Asset | Established permission | Remaining issue |
| --- | --- | --- |
| CondMDI code | MIT, retain notices | Authors explicitly reserve dependency and dataset terms. |
| Exact author random-frames checkpoint | Identity and tensor provenance verified | No separate commercial model/output grant found in README or archive. |
| HumanML3D / AMASS training material | Public AMASS grant covers non-commercial research, education, and artistic projects | AMASS explicitly restricts commercial-use model training and dataset redistribution. The downstream legal implications for published weights require clarification. |
| DART | Authors expressly license their code and model Apache-2.0 | Authors also retain AMASS and SMPL-family terms. It is not an established escape from those dependencies. |
| AnyTop pretrained model | Non-commercial research only | Separate model terms explicitly exclude rights to Truebones data. |
| UniMate pretrained model | CC-BY-NC-4.0 | No commercial model grant; third-party data rights excluded. |

Sources: [CondMDI code and scope](https://github.com/setarehc/diffusion-motion-inbetweening#license), [HumanML3D origins and distribution](https://github.com/EricGuo5513/HumanML3D), [AMASS license](https://amass.is.tue.mpg.de/license.html), [DART scope](https://github.com/zkf1997/DART#license), [AnyTop model license](https://huggingface.co/inbar2344/AnyTop/raw/main/LICENSE), [UniMate model license](https://huggingface.co/Linzhan/UniMate/raw/main/LICENSE).

AMASS lists Max Planck as licensor and offers a commercial licensing contact. We have prepared [specific permission requests](model-permission-requests.md), including commercial inference, checkpoint distribution/conversion, downstream customer outputs, and the contributor rights chain. They remain unsent. Keeping weights local avoids redistributing them with the app; it does not establish permission for commercial use.

SMPL has separate **Model** and **Body** licenses. The latter has CC-BY-4.0 terms, while the Model terms restrict commercial use without another license. Avoid treating the shared name or a skeleton convention as proof that a particular model asset was downloaded or required. Still's fresh model uses ordinary named joints and does not load SMPL parameters. ([Model](https://smpl.is.tue.mpg.de/modellicense.html), [Body](https://smpl.is.tue.mpg.de/bodylicense.html))

## A data source with an explicit commercial permission chain

Quaternius publishes the [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html), [Library 2](https://quaternius.com/packs/universalanimationlibrary2.html), and [Ultimate Animated Animal Pack](https://quaternius.com/packs/ultimateanimatedanimals.html) under CC0. The author expressly permits commercial use. CC0 waives the affirmer's applicable copyright/database rights for all purposes, with a fallback license; it does not grant third-party patents or guarantee unrelated rights. This is a documented training-data permission basis, not a blanket product certification. ([Author FAQ](https://quaternius.com/faq.html), [CC0 legal text](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en))

The humanoid training pipeline downloads the creator's free Standard archives, retains their included CC0 license, records archive and GLB hashes, converts only those clips, and reserves complete clip identities for evaluation. UAL1 archive SHA-256 is `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`; UAL2 is `4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68`. The usable corpus has 81 clips: 65 train and 16 held out, with 107 seconds of original training frames. Normalization statistics come only from the training split. This is a small stylized corpus and does not establish broad motion quality. ([Local acquisition record](../.local/owned-humanoid/sources.json), [dataset index](../.local/owned-humanoid/dataset/index.json))

The fresh model must start from random parameters, recompute all statistics, and exclude CondMDI/AMASS/Truebones pretrained weights or outputs as training material. New source clips need a pinned origin and an explicit license. Adobe's Mixamo Additional Terms restrict use of Mixamo-derived content to create, train, test, or improve ML systems, so Mixamo imports are not a training-data permission route. Prefer these CC0 clips for further ML benchmarks as well. ([Adobe's terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf))

For broader realistic motion coverage, commission capture/animation with express model-training, weight distribution, and customer-output rights, or negotiate a purpose-specific dataset agreement. Rokoko publicly offers an ML motion dataset and training samples before a commercial agreement; its public sales page is not itself a license grant. ([Rokoko dataset offering](https://www.rokoko.com/mocap/motion-dataset))

## The release check is separate from local generation

[backend/model-rights.json](../backend/model-rights.json) records code, checkpoint, data, and output scope separately. `get_model_rights(provider_id)` returns the evidence; `assert_commercial_release(provider_id)` rejects unknown/restricted entries and changed checkpoint hashes. It is a packaging check only and does not stop local inference. It cannot replace a complete dependency/notice review or grant rights in a user's imported content. No provider becomes cleared merely because its code is MIT or its model file exists.
