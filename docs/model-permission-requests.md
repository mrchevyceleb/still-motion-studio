# Model permission requests — prepared, not sent

Prepared October 8, 2026. No message has been sent. These drafts request a grant; they are not evidence that one exists.

## CondMDI checkpoint and output permission

To: Setareh Cohan, setarehc@cs.ubc.ca, the published contact on [her university page](https://www.cs.ubc.ca/~setarehc/). Ask her to identify the entity authorized to license the trained checkpoint and route any university/coauthor approvals.

Subject: Commercial license clarification for CondMDI random-frames checkpoint

Hello Setareh,

We are building Still, a local desktop animation editor that accepts users' humanoid rigs and sparse authored poses, generates the motion between them, and returns animation to the original skeleton. We would like to offer this in a commercial product and let users use/export the resulting motion in commercial games, films, and other projects.

We evaluated your published random-frames archive (`model000750000.pt`, averaged `model_avg`, author download ID `15mYPp2U0VamWfu1SnwCukUUHczY9RPIP`). Our SafeTensors conversion has SHA-256 `ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361`; its 196 retained learned tensors match your averaged checkpoint exactly. We do not use the SMPL mesh renderer or redistribute AMASS motion files. Inference runs locally; users' characters stay on their computers.

The repository expressly grants MIT terms to code and requires following separate dependency/dataset terms. Please confirm the license applying to this exact checkpoint, including commercial inference, modification/format conversion, fine-tuning, redistribution or a user-initiated download, and end-user commercial use and export of generated skeletal animation. Please state any attribution, reporting, fee, distribution, or output restrictions.

Please also identify the checkpoint licensor and confirm whether its training-data permissions authorize those uses. AMASS's public license restricts training for commercial use. We would appreciate either the applicable separate permissions or a clear list of additional rightsholders we must approach, including whether generated joint-only animation carries any dataset/body-model obligations. We can keep downloads separate from the application if that is required, but do not assume that changes the permission needed.

If a separate agreement is required, please send the appropriate commercial licensing contact and terms. We will preserve required notices and document the exact licensed artifact.

Thank you,
Matt / Still animation editor

## AMASS commercial training and downstream model scope

To: ps-license@tue.mpg.de, the commercial licensing address in the [AMASS license](https://amass.is.tue.mpg.de/license.html).

Subject: AMASS permission scope for a commercial local motion-inbetweening model

Hello,

We are evaluating a commercial local animation editor, Still. A research prototype uses the publicly released CondMDI random-frames checkpoint trained on HumanML3D, which incorporates AMASS-derived motion. We do not distribute AMASS motion files or use an SMPL mesh model in our inference/export pipeline. The intended output is joint animation on a user's own rig.

We understand that AMASS's public license is non-commercial and explicitly restricts training neural networks for commercial use. Please clarify the permission needed to commercially run and distribute an already-trained third-party checkpoint, permit customers' commercial use/export of generated skeletal motion, and independently train or fine-tune a replacement using AMASS.

Please identify which rights Max Planck can grant, which underlying capture contributors require separate permission, whether HumanML3D preprocessing/annotations introduce additional obligations, and whether an agreement can cover model weights, commercial inference, redistribution, sublicensing to customers, and generated outputs. Please provide pricing/scope options and any required notices, retention limits, restrictions, or reporting requirements. We are seeking written clarification rather than assuming the research license covers these uses.

Thank you,
Matt / Still animation editor

## Other contacts if the proposed grant requires them

HumanML3D's maintainers publish **Chuan Guo, cguo2@ualberta.ca** as the dataset contact. Ask which annotation/processing rights they control and which original motion rights remain separate; do not ask them to license AMASS rights they do not hold. ([HumanML3D README](https://github.com/EricGuo5513/HumanML3D))

If an implementation actually incorporates SMPL-Model parameters/software, its commercial licensing page gives **smpl@max-planck-innovation.de** and refers to Meshcapade. SMPL-Body's separate CC-BY-4.0 terms should not be confused with an unrestricted grant for SMPL-Model or AMASS. ([SMPL-Model terms](https://smpl.is.tue.mpg.de/modellicense.html), [SMPL-Body terms](https://smpl.is.tue.mpg.de/bodylicense.html))
