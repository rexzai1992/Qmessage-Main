import type { Express } from 'express'

export function registerPublicInfoRoutes(app: Express, ctx: any) {
    const { renderPublicInfoPage } = ctx

    app.get('/support', (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Support',
            subtitle: 'Need help with your Q Message workspace?',
            paragraphs: [
                'Our team is here to help with onboarding, integration, and account troubleshooting.',
                'Email us at hello@2fast.xyz and include your workspace ID, issue summary, and screenshots if available.',
                'For urgent account access or webhook setup issues, mention your phone number ID and WABA ID in the email.'
            ]
        }))
    })

    app.get(['/privacy', '/privacy-policy'], (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Privacy Policy',
            subtitle: 'How Q Message handles your information',
            paragraphs: [
                'We collect and process account and operational data required to provide messaging services and support.',
                'We use your data to operate the platform, secure accounts, troubleshoot issues, and improve reliability.',
                'We do not sell customer data. Access is limited to authorized personnel and service providers under confidentiality obligations.',
                'To request data corrections or privacy support, contact hello@2fast.xyz.'
            ]
        }))
    })

    app.get(
        ['/data-deletion', '/user-data-deletion', '/user-data-deletion-request'],
        (_req: any, res: any) => {
            res.setHeader('content-type', 'text/html; charset=utf-8')
            return res.send(renderPublicInfoPage({
                title: 'User Data Deletion Request',
                subtitle: 'Q Message - WhatsApp Business API SaaS platform',
                paragraphs: [
                    'Q Message allows users to request deletion of personal data processed through our WhatsApp Business API SaaS platform.',
                    'To request deletion, email hello@2fast.xyz with the subject "User Data Deletion Request".',
                    'Please include enough details for us to verify and locate your account, such as your name, registered email, phone number, and account or workspace ID if available.',
                    'After verification, we will process your request within a reasonable timeframe, typically 7 to 14 days.',
                    'Depending on your account usage, data that may be deleted includes account profile details, contact and conversation records, stored message content, and related operational logs tied to your account.',
                    'We handle deletion requests securely and limit access to authorized personnel only.'
                ]
            }))
        }
    )

    app.get(['/terms', '/terms-and-conditions'], (_req: any, res: any) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return res.send(renderPublicInfoPage({
            title: 'Terms & Conditions',
            subtitle: 'Effective date: 17 April 2026',
            paragraphs: [
                'These Terms and Conditions govern your access to and use of Q Message services, including our web application, APIs, integrations, and support channels.',
                'By creating an account, accessing the platform, or using any Q Message service, you agree to be bound by these Terms and all applicable laws and regulations.',
                'You are responsible for maintaining the confidentiality of account credentials, assigning access only to authorized users, and promptly revoking access for users who should no longer have permissions.',
                'You agree to use the platform only for lawful business purposes and in compliance with all applicable anti-spam, privacy, consumer protection, and telecommunications laws in your jurisdiction.',
                'You must comply with all third-party platform rules connected to your use of Q Message, including Meta and WhatsApp Business Platform policies, commerce policies, and messaging rules.',
                'You must not use Q Message to send spam, phishing, deceptive messages, malware, illegal content, or any communication that infringes intellectual property, privacy, or other legal rights.',
                'You are responsible for the legality, accuracy, and ownership of all messages, media, templates, contacts, and other content submitted or transmitted through your account.',
                'Service availability may vary based on scheduled maintenance, security updates, infrastructure incidents, and third-party dependency outages, including cloud providers and API platforms.',
                'Q Message may suspend or terminate access, in whole or in part, if we reasonably believe your use violates these Terms, threatens platform security, or creates legal or operational risk.',
                'To the maximum extent permitted by law, Q Message provides services on an "as is" and "as available" basis without warranties of uninterrupted or error-free operation.',
                'To the maximum extent permitted by law, Q Message will not be liable for indirect, incidental, special, consequential, or punitive damages, including lost profits, business interruption, or data loss.',
                'If any provision of these Terms is found unenforceable, the remaining provisions will continue in full force and effect.',
                'We may update these Terms from time to time. Continued use of Q Message after an update constitutes acceptance of the revised Terms.',
                'For account, billing, compliance, or legal inquiries, contact hello@2fast.xyz.'
            ]
        }))
    })
}

