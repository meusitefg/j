# Minha Central

Dashboard responsiva em preto e branco para organizar contas Gmail e Outlook. O botão **Copiar login** coloca o e-mail na primeira linha e a senha na segunda. Ao excluir um tópico, os logins passam para **Sem tópico**.

## Conectar o banco gratuito

1. Crie um projeto no [Supabase](https://supabase.com/dashboard) no plano Free. Se for usar o Lovable, conecte esse mesmo projeto pela integração Supabase do Lovable.
2. Em **Authentication → Sign In / Providers → Email**, desative novos cadastros. Em **Authentication → Users**, crie e confirme manualmente o usuário `admsupremo1@gmail.com` com a senha de acesso escolhida. A senha é definida no painel de autenticação do Supabase.
3. Copie o UUID desse usuário. Abra `schema.sql`, substitua as quatro ocorrências de `00000000-0000-0000-0000-000000000000` pelo UUID e execute o SQL uma vez no **SQL Editor**.
4. Em `config.js`, preencha `url` com a URL do projeto e `publishableKey` com a chave **Publishable**. A chave legada `anon` também funciona. Mantenha a chave `service_role` e as chaves secretas fora do site.
5. Publique apenas `index.html`, `app.js` e `config.js` juntos em um host estático com HTTPS. Para testar localmente, execute `python3 -m http.server 8000` na pasta e abra `http://localhost:8000`.

## Dados e acesso

O cadastro público fica desativado. As políticas RLS autorizam somente o UUID definido no SQL a ler e modificar os dados. O navegador usa a senha de entrada para derivar a chave que cifra e decifra os e-mails e as senhas armazenados. A sessão e a chave de decifragem ficam no armazenamento temporário da aba, permitindo atualizar a página sem sair. Clique em **Sair** para limpar a sessão. Use o seletor ao lado do e-mail para marcar **ON**, **OFF** ou **RISCO** e **Mostrar senha** para revelar a senha no cartão. A atualização usa o esquema existente.

Uma troca de senha de entrada no Supabase muda a chave que o site deriva. Antes de trocar a senha de entrada, certifique-se de ter uma cópia dos logins para recadastrá-los com a nova senha. A dashboard anterior salvava dados apenas no navegador. Caso você já tenha registros, recadastre-os na nova dashboard e mantenha os dados anteriores até confirmar a transferência.
