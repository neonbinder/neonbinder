"use client";

import React, { useState } from "react";
import {
  Button,
  Input,
  Checkbox,
  Switch,
  RadioButton,
  Textarea,
  Accordion,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Avatar,
  MenuItem,
  MenuSectionTitle,
  NavigationMenu,
  NavigationMenuItem,
  Collapsible,
  TableItem,
  Menubar,
  MenubarItem,
  Palette,
  InlineCode,
  ScrollListItem,
  Poster,
} from "../../../components/primitives";

export default function PrimitivesPage() {
  const [switchChecked, setSwitchChecked] = useState(false);
  const [radioValue, setRadioValue] = useState("option1");
  const [checkboxChecked, setCheckboxChecked] = useState(false);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">
            Primitives
          </h1>
          <p className="mt-2 text-xl text-slate-600 max-w-2xl">
            Those are the atomic parts that make your components, do NOT edit
            unless you strictly want to.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="space-y-16">
          {/* Button Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Button
            </h2>
            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-4">
                <Button variant="default">Continue</Button>
                <Button variant="primary">Continue</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="outline">Cancel</Button>
                <Button variant="subtle">Subtle</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
              </div>
              <div className="space-y-4">
                <Button variant="withIcon" icon={<span>📧</span>}>
                  Login with Email
                </Button>
                <Button variant="justIcon">+</Button>
                <Button variant="justIconCircle">+</Button>
                <Button variant="loading" isLoading>
                  Loading
                </Button>
              </div>
            </div>
          </section>

          {/* Input Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Input
            </h2>
            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-6">
                <Input
                  label="Email"
                  placeholder="Email"
                  helperText="Enter your email address"
                  variant="withButton"
                  buttonText="Subscribe"
                />
                <Input
                  label="Email"
                  placeholder="Email"
                  value="pietro.schirano@gmail.com"
                  helperText="Enter your email address"
                  variant="withButton"
                  buttonText="Subscribe"
                  state="completed"
                />
                <Input
                  label="Email"
                  placeholder="Email"
                  helperText="Enter your email address"
                  variant="withButton"
                  buttonText="Subscribe"
                  state="focused"
                />
              </div>
              <div className="space-y-6">
                <Input
                  label="Width"
                  placeholder="Add value"
                  labelPosition="left"
                />
                <Input
                  label="Width"
                  value="100%"
                  labelPosition="left"
                  state="completed"
                />
                <Input
                  label="Width"
                  placeholder="Add value"
                  labelPosition="left"
                  state="disabled"
                />
              </div>
            </div>
          </section>

          {/* Form Controls Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Form Controls
            </h2>
            <div className="grid grid-cols-3 gap-8">
              {/* Checkbox */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-slate-900">Checkbox</h3>
                <Checkbox
                  label="Accept terms and condition"
                  checked={checkboxChecked}
                  onChange={(e) => setCheckboxChecked(e.target.checked)}
                />
                <Checkbox
                  label="Accept terms and condition"
                  description="You agree to our Terms of Service and Privacy Policy."
                  variant="withText"
                />
              </div>

              {/* Switch */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-slate-900">Switch</h3>
                <Switch
                  label="Airplane mode"
                  checked={switchChecked}
                  onCheckedChange={setSwitchChecked}
                />
              </div>

              {/* Radio Button */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-slate-900">
                  Radio Button
                </h3>
                <RadioButton
                  label="Default"
                  name="radio-group"
                  value="option1"
                  checked={radioValue === "option1"}
                  onChange={(e) => setRadioValue(e.target.value)}
                />
                <RadioButton
                  label="Selected"
                  name="radio-group"
                  value="option2"
                  checked={radioValue === "option2"}
                  onChange={(e) => setRadioValue(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* Textarea Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Textarea
            </h2>
            <div className="grid grid-cols-2 gap-8">
              <Textarea
                label="Your message"
                placeholder="Type your message here"
                helperText="Your message will be copied to the support team."
              />
              <Textarea
                label="Your message"
                placeholder="Type your message here"
                variant="withButton"
                buttonText="Send message"
              />
            </div>
          </section>

          {/* Tabs Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">Tabs</h2>
            <div className="max-w-md">
              <Tabs defaultValue="account">
                <TabsList>
                  <TabsTrigger value="account">Account</TabsTrigger>
                  <TabsTrigger value="password">Password</TabsTrigger>
                </TabsList>
                <TabsContent
                  value="account"
                  className="mt-6 p-6 border border-slate-200 rounded-md"
                >
                  <p className="text-sm text-slate-500 mb-4">
                    Make changes to your account here. Click save when
                    you&apos;re done.
                  </p>
                  <div className="space-y-4">
                    <Input label="Name" value="Pietro Schirano" />
                    <Input label="Username" value="@skirano" />
                    <Button variant="default">Save changes</Button>
                  </div>
                </TabsContent>
                <TabsContent
                  value="password"
                  className="mt-6 p-6 border border-slate-200 rounded-md"
                >
                  <p className="text-sm text-slate-500">
                    Change your password here.
                  </p>
                </TabsContent>
              </Tabs>
            </div>
          </section>

          {/* Avatar Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Avatar
            </h2>
            <div className="flex items-center gap-4">
              <Avatar fallback="CN" />
              <Avatar
                src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                alt="User Avatar"
              />
            </div>
          </section>

          {/* Menu Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">Menu</h2>
            <div className="max-w-sm border border-slate-200 rounded-md bg-white">
              <div className="p-2">
                <MenuItem leftIcon={<span>←</span>} rightText="⌘[">
                  Back
                </MenuItem>
                <MenuItem rightText="⌘]" disabled>
                  Forward
                </MenuItem>
                <MenuItem rightText="⌘R">Reload</MenuItem>
                <MenuItem rightIcon={<span>→</span>} selected>
                  More Tools
                </MenuItem>
                <div className="my-2 h-px bg-slate-200" />
                <MenuSectionTitle withPaddingLeft>People</MenuSectionTitle>
                <MenuItem>Pedro Duarte</MenuItem>
                <MenuItem>Colm Tuite</MenuItem>
                <MenuItem>Pietro Schirano</MenuItem>
              </div>
            </div>
          </section>

          {/* Navigation Menu Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Navigation Menu
            </h2>
            <NavigationMenu>
              <NavigationMenuItem value="getting-started" type="dropdown">
                Getting started
              </NavigationMenuItem>
              <NavigationMenuItem value="components" type="dropdown">
                Components
              </NavigationMenuItem>
              <NavigationMenuItem value="documentation" type="dropdown">
                Documentation
              </NavigationMenuItem>
            </NavigationMenu>
          </section>

          {/* Menubar Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Menubar
            </h2>
            <Menubar>
              <MenubarItem value="file">File</MenubarItem>
              <MenubarItem value="edit">Edit</MenubarItem>
              <MenubarItem value="view">View</MenubarItem>
              <MenubarItem value="profile">Profile</MenubarItem>
            </Menubar>
          </section>

          {/* Accordion Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Accordion
            </h2>
            <div className="max-w-md">
              <Accordion
                items={[
                  {
                    id: "1",
                    trigger: "Is it accessible?",
                    content: "Yes. It adheres to the WAI-ARIA design pattern.",
                  },
                  {
                    id: "2",
                    trigger: "Is it styled?",
                    content:
                      "Yes. It comes with default styles that match the design.",
                  },
                ]}
              />
            </div>
          </section>

          {/* Collapsible Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Collapsible
            </h2>
            <div className="max-w-sm">
              <Collapsible
                trigger="@peduarte starred 3 repositories"
                defaultOpen={false}
              >
                <div className="space-y-2">
                  <Input value="@radix-ui/primitives" inputSize="small" />
                  <Input value="@radix-ui/colors" inputSize="small" />
                  <Input value="@stitches/react" inputSize="small" />
                </div>
              </Collapsible>
            </div>
          </section>

          {/* Table Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Table
            </h2>
            <table className="border-collapse border border-slate-200">
              <thead>
                <tr>
                  <TableItem type="head">King&apos;s Treasury</TableItem>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <TableItem>Empty</TableItem>
                </tr>
                <tr>
                  <TableItem selected>Modest</TableItem>
                </tr>
              </tbody>
            </table>
          </section>

          {/* Utility Components Section */}
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-8">
              Utility Components
            </h2>
            <div className="grid grid-cols-4 gap-8">
              {/* Palette */}
              <div>
                <h3 className="text-lg font-medium text-slate-900 mb-4">
                  Palette
                </h3>
                <Palette color="#FCFCFD" name="slate" shade="50" />
              </div>

              {/* Inline Code */}
              <div>
                <h3 className="text-lg font-medium text-slate-900 mb-4">
                  Inline Code
                </h3>
                <InlineCode>@radix-ui/react-alert-dialog</InlineCode>
              </div>

              {/* Scroll List Item */}
              <div>
                <h3 className="text-lg font-medium text-slate-900 mb-4">
                  Scroll List Item
                </h3>
                <ScrollListItem>v1.2.0-beta.50</ScrollListItem>
              </div>

              {/* Poster */}
              <div>
                <h3 className="text-lg font-medium text-slate-900 mb-4">
                  Poster
                </h3>
                <Poster
                  title="shadcn/ui"
                  description="Beautifully designed components built with Radix UI and Tailwind CSS."
                  icon={<div className="w-6 h-6 bg-white rounded-full" />}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
